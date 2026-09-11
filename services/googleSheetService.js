// services/googleSheetService.js
import { google } from 'googleapis';

/**
 * Menambahkan baris riwayat chat ke Google Sheets
 */
export async function appendChatToSheet(refreshToken, spreadsheetId, chatData) {
  try {
    if (!refreshToken || !spreadsheetId) return;

    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({ refresh_token: refreshToken });
    const sheets = google.sheets({ version: 'v4', auth });

    const values = [
      [
        chatData.timestamp || new Date().toLocaleString('id-ID'),
        chatData.sender,
        chatData.message,
        chatData.reply
      ]
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: 'Sheet1!A:D',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
  } catch (error) {
    console.error('❌ [GOOGLE SHEETS CHAT ERR]:', error.message);
  }
}

/**
 * Menambahkan data produk baru ke Google Sheets pada tab 'Produk'
 */
export async function appendProductToSheet(refreshToken, spreadsheetId, productData) {
  try {
    if (!refreshToken || !spreadsheetId) return;

    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({ refresh_token: refreshToken });
    const sheets = google.sheets({ version: 'v4', auth });

    const values = [
      [
        new Date().toLocaleString('id-ID'),
        productData.name,
        productData.price,
        productData.description,
        productData.imageUrl || '-'
      ]
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: 'Produk!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    }).catch(async (err) => {
      // Jika tab 'Produk' belum ada, buatkan otomatis
      if (err.message.includes('Unable to parse range')) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title: 'Produk' } } }]
          }
        });
        // Ulangi append setelah sheet dibuat
        await sheets.spreadsheets.values.append({
          spreadsheetId: spreadsheetId,
          range: 'Produk!A:E',
          valueInputOption: 'USER_ENTERED',
          requestBody: { values },
        });
      }
    });

    console.log(`✅ [GOOGLE SHEETS] Produk "${productData.name}" berhasil ditambahkan ke Sheet.`);
  } catch (error) {
    console.error('❌ [GOOGLE SHEETS PRODUCT ERR]:', error.message);
  }
}