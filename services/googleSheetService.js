import { google } from "googleapis";
import fs from "fs";

export function getOAuth2Client(refreshToken) {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL || 'https://wasaas.my.id'}/api/auth/google/callback`
  );
  if (refreshToken) {
    oAuth2Client.setCredentials({ refresh_token: refreshToken });
  }
  return oAuth2Client;
}

export async function ensureProductSpreadsheet(refreshToken) {
  const auth = getOAuth2Client(refreshToken);
  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });

  // Cari file spreadsheet bernama "Katalog Produk WA AutoBot"
  const searchRes = await drive.files.list({
    q: "name = 'Katalog Produk WA AutoBot' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
    fields: "files(id, name)"
  });

  if (searchRes.data.files.length > 0) {
    return searchRes.data.files[0].id;
  }

  // Buat spreadsheet baru jika belum tersedia
  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: "Katalog Produk WA AutoBot" },
      sheets: [
        {
          properties: { title: "Katalog" },
          data: [
            {
              startRow: 0,
              startColumn: 0,
              rowData: [
                {
                  values: [
                    { userEnteredValue: { stringValue: "Waktu Tambah" } },
                    { userEnteredValue: { stringValue: "Nama Produk" } },
                    { userEnteredValue: { stringValue: "Harga (Rp)" } },
                    { userEnteredValue: { stringValue: "Deskripsi" } },
                    { userEnteredValue: { stringValue: "Link Gambar Google Drive" } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  });

  return createRes.data.spreadsheetId;
}

export async function uploadImageToDriveAndCleanup(refreshToken, filePath, fileName, mimeType) {
  try {
    const auth = getOAuth2Client(refreshToken);
    const drive = google.drive({ version: "v3", auth });

    const file = await drive.files.create({
      requestBody: {
        name: fileName
      },
      media: {
        mimeType: mimeType,
        body: fs.createReadStream(filePath)
      },
      fields: "id"
    });

    const fileId = file.data.id;

    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: "reader", type: "anyone" }
    });

    // Hapus file dari penyimpanan lokal server agar server tidak bengkak
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    return `https://drive.google.com/uc?id=${fileId}`;
  } catch (err) {
    console.error("❌ [GOOGLE DRIVE UPLOAD ERROR]:", err.message);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return null;
  }
}

export async function appendProductToSheet(refreshToken, spreadsheetId, productData) {
  try {
    const auth = getOAuth2Client(refreshToken);
    const sheets = google.sheets({ version: "v4", auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: "Katalog!A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            new Date().toLocaleString("id-ID"),
            productData.name,
            productData.price,
            productData.description || "-",
            productData.imageUrl || "-"
          ]
        ]
      }
    });
  } catch (err) {
    console.error("❌ [GOOGLE SHEET APPEND ERROR]:", err.message);
  }
}