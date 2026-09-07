// services/googleSheetService.js
import { google } from 'googleapis';

/**
 * Menambahkan baris pesan baru ke Google Sheets milik User
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

    console.log(`✅ [GOOGLE SHEETS] Log chat berhasil diarsip ke Sheet: ${spreadsheetId}`);
  } catch (error) {
    console.error('❌ [GOOGLE SHEETS ERROR]:', error.message);
  }
}