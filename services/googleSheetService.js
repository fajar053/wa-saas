import { google } from "googleapis";
import fs from "fs";

function getOAuth2Client(refreshToken) {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.APP_URL || "https://wasaas.my.id"
  );
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return oAuth2Client;
}

export async function uploadImageToDrive(refreshToken, filePath, fileName, mimeType) {
  try {
    const auth = getOAuth2Client(refreshToken);
    const drive = google.drive({ version: "v3", auth });

    const fileMetadata = {
      name: fileName,
      parents: [] // Bisa diisi ID Folder khusus Google Drive jika ada
    };

    const media = {
      mimeType: mimeType,
      body: fs.createReadStream(filePath)
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: "id, webViewLink, webContentLink"
    });

    const fileId = file.data.id;

    // Ubah akses gambar agar bisa dilihat secara publik
    await drive.permissions.create({
      fileId: fileId,
      requestBody: {
        role: "reader",
        type: "anyone"
      }
    });

    return `https://drive.google.com/uc?id=${fileId}`;
  } catch (err) {
    console.error("❌ [GOOGLE DRIVE UPLOAD ERR]:", err.message);
    return null;
  }
}

export async function appendProductToSheet(refreshToken, spreadsheetId, productData) {
  try {
    const auth = getOAuth2Client(refreshToken);
    const sheets = google.sheets({ version: "v4", auth });

    const values = [
      [
        new Date().toLocaleString("id-ID"),
        productData.name,
        productData.price,
        productData.description || "-",
        productData.imageUrl || "-"
      ]
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: "Sheet1!A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: { values }
    });

    console.log("✅ [GOOGLE SHEET APPEND SUCCESS] Data produk tersinkronisasi");
  } catch (err) {
    console.error("❌ [GOOGLE SHEET APPEND ERR]:", err.message);
  }
}