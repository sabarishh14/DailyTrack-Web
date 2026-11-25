function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const type = payload.type || "transactions";
    const data = payload.data || payload; 
    const records = Array.isArray(data) ? data : [data];
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // ==========================================
    // 1. TRIGGER OCR FOR BALANCES
    // ==========================================
    if (type === "trigger_ocr") {
      const res = triggerOCR();
      return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
    }
    
    // ==========================================
    // 1.5 OCR A SPECIFIC SPLIT IMAGE FROM GDRIVE FOLDER
    // ==========================================
    else if (type === "ocr_split") {
      try {
        const FOLDER_ID = "1QdOpIOuHhzOEtXGhBhswtgiY0c-nKF5N"; // Folder ID
        const folder = DriveApp.getFolderById(FOLDER_ID);
        const files = folder.getFiles();
        
        let processed = false;
        let text = "";
        
        while (files.hasNext()) {
          const file = files.next();
          if (file.getMimeType().includes("image")) {
            const blob = file.getBlob();
            const resource = { title: file.getName() };
            
            const docFile = Drive.Files.insert(resource, blob, { ocr: true, ocrLanguage: "en" });
            const doc = DocumentApp.openById(docFile.id);
            text = doc.getBody().getText();
            
            DriveApp.getFileById(docFile.id).setTrashed(true);
            file.setTrashed(true);
            processed = true;
            break; // Only process one split at a time
          }
        }
        
        if (!processed) {
           return ContentService.createTextOutput(JSON.stringify({status: "error", message: "No images found in the GDrive folder!"})).setMimeType(ContentService.MimeType.JSON);
        }
        
        return ContentService.createTextOutput(JSON.stringify({status: "success", text: text})).setMimeType(ContentService.MimeType.JSON);
      } catch (e) {
        return ContentService.createTextOutput(JSON.stringify({status: "error", message: e.toString()})).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // ==========================================
    // 2. INSERT OR EDIT TRANSACTIONS
    // ==========================================
    else if (type === "transactions") {
      let errors = [];
      let inserted = 0;

      // Every ID already on a sheet, read once: { id: { sheet, row } }.
      const idCache = {};
      for (const s of transactionSheets(ss)) {
        const L = layoutOf(s);
        const last = s.getLastRow();
        if (last < 2) continue;
        const ids = s.getRange(2, L.id, last - 1, 1).getValues();
        for (let i = 0; i < ids.length; i++) {
          if (ids[i][0] !== "" && ids[i][0] !== null) idCache[normalizeId(ids[i][0])] = { sheet: s, row: i + 2 };
        }
      }

      // Grouped by sheet, so each sheet's dates are read once.
      const txBySheet = {};

      records.forEach(tx => {
        const { date, month, type: rawType, heading, description, amount, account } = tx;
        const id = tx.id || Utilities.getUuid();
        const sheetName = sheetNameFor(account);
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet) { errors.push(sheetName); return; }
        const L = layoutOf(sheet);

        const txDate = new Date(date);
        txDate.setHours(0, 0, 0, 0);
        const formattedType = rawType ? rawType.charAt(0).toUpperCase() + rawType.slice(1).toLowerCase() : "";

        // Already on a sheet: an edit.
        const cached = idCache[normalizeId(id)];
        if (cached) {
          const foundSheet = cached.sheet;
          const existingRow = cached.row;
          const existingDate = new Date(foundSheet.getRange(existingRow, 1).getValue());
          existingDate.setHours(0, 0, 0, 0);

          if (foundSheet.getName() === sheetName && existingDate.getTime() === txDate.getTime()) {
            // Same sheet, same day: update in place.
            foundSheet.getRange(existingRow, 1, 1, 6).setValues([[new Date(date), month, formattedType, heading, description, amount]]);
            foundSheet.getRange(existingRow, L.account).setValue(account);
            inserted++;
            return;
          }
          // Another day or sheet: the old row goes, and it's inserted afresh below.
          removeRow(foundSheet, existingRow);
        }

        if (!txBySheet[sheetName]) txBySheet[sheetName] = [];
        txBySheet[sheetName].push({ date, month, formattedType, heading, description, amount, account, txDate, id, createdAt: new Date() });
      });

      for (const sheetName in txBySheet) {
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet) continue;
        const L = layoutOf(sheet);

        // Oldest first, so inserts don't shift each other's places.
        const txList = txBySheet[sheetName].sort((a, b) => a.txDate - b.txDate);

        for (const tx of txList) {
          const lastUsed = sheet.getLastRow();
          const colA = sheet.getRange(1, 1, lastUsed || 1).getValues();
          let lastDataRow = 0;
          for (let i = colA.length - 1; i >= 0; i--) {
            if (colA[i][0] !== "") { lastDataRow = i + 1; break; }
          }

          // Kept in date order: before the first row with a later date.
          let insertRow = lastDataRow + 1;
          if (lastDataRow >= 2) {
            const dateValues = sheet.getRange(2, 1, lastDataRow - 1, 1).getValues();
            for (let i = 0; i < dateValues.length; i++) {
              if (!dateValues[i][0]) continue;
              const cellDate = new Date(dateValues[i][0]);
              cellDate.setHours(0, 0, 0, 0);
              if (cellDate > tx.txDate) { insertRow = i + 2; break; }
            }
          }

          sheet.insertRowBefore(insertRow);
          sheet.getRange(insertRow, 1, 1, 6).setValues([[new Date(tx.date), tx.month, tx.formattedType, tx.heading, tx.description, tx.amount]]);
          const sourceRow = (insertRow > 2) ? insertRow - 1 : (lastDataRow >= 2 ? insertRow + 1 : 0);
          if (sourceRow > 0) {
            sheet.getRange(sourceRow, 1, 1, 6).copyTo(sheet.getRange(insertRow, 1, 1, 6), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
            // The running totals: the row above's formulas, and the row below re-pointed at this one.
            if (L.calcWidth > 0) {
              sheet.getRange(sourceRow, L.firstCalc, 1, L.calcWidth).copyTo(sheet.getRange(insertRow, L.firstCalc, 1, L.calcWidth));
              if (insertRow < sheet.getLastRow()) {
                sheet.getRange(insertRow, L.firstCalc, 1, L.calcWidth).copyTo(sheet.getRange(insertRow + 1, L.firstCalc, 1, L.calcWidth));
              }
            }
          }
          sheet.getRange(insertRow, L.account).setValue(tx.account);
          sheet.getRange(insertRow, L.id).setValue(tx.id);
          sheet.getRange(insertRow, L.created).setValue(tx.createdAt);
          inserted++;
        }
      }

      SpreadsheetApp.flush();
      const msg = errors.length > 0 ? `${inserted} inserted. Skipped missing: ${[...new Set(errors)].join(", ")}` : `${inserted} transactions processed`;
      return ContentService.createTextOutput(JSON.stringify({status: "success", message: msg})).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 2. SINGLE DELETE
    // ==========================================
    else if (type === "delete_transaction") {
      const { id, account } = data;
      const sheet = ss.getSheetByName(sheetNameFor(account));
      if (!sheet) return ContentService.createTextOutput(JSON.stringify({status: "error", message: "Sheet not found"})).setMimeType(ContentService.MimeType.JSON);

      const row = rowOfId(sheet, id);
      if (row > 0) {
        removeRow(sheet, row);
        SpreadsheetApp.flush();
      }
      return ContentService.createTextOutput(JSON.stringify({status: "success", message: "Transaction deleted"})).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 3.5 BACKFILL MISSING IDs (ONE-TIME USE)
    // ==========================================
    else if (type === "backfill_ids") {
      let matchedCount = 0;
      const dbMap = {}; // sheet name -> [{ sig, id, date, used }]

      // Each transaction's signature: date, amount and heading.
      records.forEach(tx => {
        const sheetName = sheetNameFor(tx.account);
        if (!dbMap[sheetName]) dbMap[sheetName] = [];
        const txDate = new Date(tx.date);
        const sig = `${txDate.getFullYear()}-${txDate.getMonth()+1}-${txDate.getDate()}_${tx.amount}_${tx.heading}`.toLowerCase();
        dbMap[sheetName].push({ sig: sig, id: tx.id, date: tx.date, used: false });
      });

      for (const sheetName in dbMap) {
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet) continue;
        const L = layoutOf(sheet);
        const lastRow = sheet.getLastRow();
        if (lastRow < 2) continue;

        const values = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
        const ids = sheet.getRange(2, L.id, lastRow - 1, 1).getValues();
        const created = sheet.getRange(2, L.created, lastRow - 1, 1).getValues();
        let updated = false;

        for (let i = 0; i < values.length; i++) {
          const rawDate = values[i][0];
          const rowHeading = String(values[i][3] || "").trim();
          const rowAmount = values[i][5];
          if (ids[i][0] || !rawDate || !rowHeading || rowAmount === "") continue;
          const rowDate = new Date(rawDate);
          if (isNaN(rowDate.getTime())) continue;
          const targetSig = `${rowDate.getFullYear()}-${rowDate.getMonth()+1}-${rowDate.getDate()}_${rowAmount}_${rowHeading}`.toLowerCase();
          const match = dbMap[sheetName].find(item => item.sig === targetSig && !item.used);
          if (match) {
            match.used = true;              // claimed, so two alike rows don't take one ID
            ids[i][0] = match.id.toString();
            created[i][0] = new Date(match.date);
            updated = true;
            matchedCount++;
          }
        }

        // Only the ID and Created columns are written back.
        if (updated) {
          sheet.getRange(2, L.id, ids.length, 1).setValues(ids);
          sheet.getRange(2, L.created, created.length, 1).setValues(created);
        }
      }
      SpreadsheetApp.flush();
      return ContentService.createTextOutput(JSON.stringify({status: "success", message: `Backfilled ${matchedCount} missing IDs!`})).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 3. BULK DELETE
    // ==========================================
    else if (type === "bulk_delete_transactions") {
      let deletedCount = 0;
      const sheetDeletes = {};
      records.forEach(item => {
        const sName = sheetNameFor(item.account);
        if (!sheetDeletes[sName]) sheetDeletes[sName] = [];
        sheetDeletes[sName].push(normalizeId(item.id));
      });

      for (const sheetName in sheetDeletes) {
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet) continue;
        const L = layoutOf(sheet);
        const lastUsed = sheet.getLastRow();
        if (lastUsed < 2) continue;

        const wanted = new Set(sheetDeletes[sheetName]);
        const idValues = sheet.getRange(2, L.id, lastUsed - 1, 1).getValues();
        const rows = [];
        for (let i = 0; i < idValues.length; i++) {
          if (idValues[i][0] !== "" && wanted.has(normalizeId(idValues[i][0]))) rows.push(i + 2);
        }
        // Bottom first, so the rows above keep their places.
        rows.sort((a, b) => b - a).forEach(row => { removeRow(sheet, row); deletedCount++; });
      }
      SpreadsheetApp.flush();
      return ContentService.createTextOutput(JSON.stringify({status: "success", message: `${deletedCount} transactions bulk deleted cleanly`})).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 4. INVESTMENTS LOGIC (Stocks + MF + Total)
    // ==========================================
    else if (type === "investments") {
      const sheet = ss.getSheetByName("INVES-T-RACKER");
      if (!sheet) return ContentService.createTextOutput(JSON.stringify({status: "error", message: "Sheet INVES-T-RACKER not found"})).setMimeType(ContentService.MimeType.JSON);

      let inserted = 0;
      records.forEach(inv => {
        const snapshotDate = new Date(inv.date);
        const snapshotStr = Utilities.formatDate(snapshotDate, Session.getScriptTimeZone(), "dd/MM/yyyy");
        const lastRow = sheet.getLastRow();
        if (lastRow < 2) return;

        // Check if date already exists to prevent duplicates
        const dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
        const exists = dates.some(d => {
          if (!d[0]) return false;
          const cellStr = (d[0] instanceof Date) ? Utilities.formatDate(d[0], Session.getScriptTimeZone(), "dd/MM/yyyy") : d[0].toString();
          return cellStr === snapshotStr || d[0] === inv.date;
        });
        if (exists) return; 
  
        // Insert new row
        sheet.insertRowAfter(lastRow);
        const newRow = lastRow + 1;
        
        // Write all 13 columns directly from the Python backend!
        sheet.getRange(newRow, 1, 1, 13).setValues([[
          snapshotDate,          // A: Date
          inv.inv_stocks,        // B: INV (Stocks)
          inv.curr_stocks,       // C: CURR (Stocks)
          inv.ret_pct_stocks,    // D: RET (Stocks)
          inv.status_stocks,     // E: Stocks Status
          inv.inv_mf,            // F: INV (MF)
          inv.curr_mf,           // G: CURR (MF)
          inv.ret_pct_mf,        // H: RET (MF)
          inv.status_mf,         // I: MF Status
          inv.total_inv,         // J: Total INV
          inv.total_curr,        // K: Total CURR
          inv.total_ret_pct,     // L: Total RET
          inv.total_status       // M: Total Status
        ]]);
        
        // Ensure date is formatted cleanly
        sheet.getRange(newRow, 1).setNumberFormat("dd/MM/yyyy");
        
        inserted++;
      });
      
      return ContentService.createTextOutput(JSON.stringify({status: "success", message: `${inserted} investments synced`})).setMimeType(ContentService.MimeType.JSON);
    }

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({status: "error", message: err.toString()})).setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// SHEET LAYOUT (read from each sheet's header row)
// ==========================================
// Every transaction sheet starts Date, Month, Debit/Credit, Heading, Description,
// Amt (A-F). After Amt come its running-total columns (a bank's balance; on
// CreditCard one per card), then the account column ("Card" or "Account"), the
// ID and when it was added. They're found by their header names, so adding a
// card column (or any column) needs no change here. A header the script can't
// find falls back to where it always was.

const normalizeId = (val) => String(val).trim();

/** Which sheet an account's transactions go on. */
function sheetNameFor(account) {
  if (account === "Cash") return "IDBI";
  if (account && account.startsWith("CC")) return "CreditCard";
  return account;
}

const _layouts = {};

/** { account, id, created, firstCalc, calcWidth } column numbers for a sheet. */
function layoutOf(sheet) {
  const name = sheet.getName();
  if (_layouts[name]) return _layouts[name];
  const width = Math.max(sheet.getLastColumn(), 1);
  const head = sheet.getRange(1, 1, 1, width).getValues()[0].map(h => String(h).trim().toLowerCase());
  const col = (...names) => { const i = head.findIndex(h => names.includes(h)); return i < 0 ? 0 : i + 1; };

  const amt = col("amt", "amount") || 6;
  const account = col("card", "account") || (name === "IDBI" || name === "CreditCard" ? 9 : 8);
  const id = col("id") || (name === "IDBI" || name === "CreditCard" ? account + 1 : 10);
  const created = col("created", "created at", "added") || id + 1;
  return (_layouts[name] = { account, id, created, firstCalc: amt + 1, calcWidth: Math.max(account - amt - 1, 0) });
}

/** The sheets transactions live on: "Date" first and an "Amt" column. */
function transactionSheets(ss) {
  return ss.getSheets().filter(s => {
    if (s.getLastColumn() < 6) return false;
    const head = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(h => String(h).trim().toLowerCase());
    return head[0] === "date" && (head.includes("amt") || head.includes("amount"));
  });
}

/** The row holding an ID on a sheet, or 0. */
function rowOfId(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const ids = sheet.getRange(2, layoutOf(sheet).id, last - 1, 1).getValues();
  const want = normalizeId(id);
  for (let i = 0; i < ids.length; i++) if (ids[i][0] !== "" && normalizeId(ids[i][0]) === want) return i + 2;
  return 0;
}

/** Deletes a row, then re-points the running totals of the row that moved up into its place. */
function removeRow(sheet, row) {
  const L = layoutOf(sheet);
  sheet.deleteRow(row);
  if (L.calcWidth > 0 && row > 2 && row <= sheet.getLastRow()) {
    sheet.getRange(row - 1, L.firstCalc, 1, L.calcWidth).copyTo(sheet.getRange(row, L.firstCalc, 1, L.calcWidth));
  }
}

function doGet(e) {
  try {

    if (e.parameter.type === "transactions") {
      return getTransactions();
    }

    // Default → balances
    return getBalances();

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getBalances() {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName("OVERALL");

  const range = sheet.getRange("B4:C10").getValues();

  const result = {};

  range.forEach(row => {
    let name = row[0];
    let value = row[1];

    if (!name) return;

    name = name.replace(/[^\w\s]/g, "").trim();

    if (typeof value === "string") {
      value = Number(value.replace(/,/g, ""));
    }

    result[name] = value;
  });

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function getTransactions() {

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName("COMPLETE");

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return ContentService
      .createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();

  let allTransactions = [];

  data.forEach((row, index) => {

  allTransactions.push({
    id: index + 2,
    date: Utilities.formatDate(
      row[0],
      Session.getScriptTimeZone(),
      "yyyy-MM-dd"
    ),
    month: Utilities.formatDate(
      row[0],
      Session.getScriptTimeZone(),
      "yyyy-MM-01"
    ),
    type: row[2],
    heading: row[3],
    description: row[4],
    amount: row[5],
    account: row[6]
  });

});

  return ContentService
    .createTextOutput(JSON.stringify(allTransactions))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// REAL BALANCE OCR ENGINE
// ==========================================
function triggerOCR() {
  const FOLDER_ID = "1QdOpIOuHhzOEtXGhBhswtgiY0c-nKF5N"; // Your folder ID
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const files = folder.getFiles();

  let allText = "";
  let processed = 0;

  while (files.hasNext()) {
    const file = files.next();
    if (file.getMimeType().includes("image")) {
      const blob = file.getBlob();
      const resource = { title: file.getName() };
      
      // Requires Advanced Drive API Service!
      const docFile = Drive.Files.insert(resource, blob, { ocr: true, ocrLanguage: "en" });
      const doc = DocumentApp.openById(docFile.id);
      allText += doc.getBody().getText() + "\n";

      DriveApp.getFileById(docFile.id).setTrashed(true);
      file.setTrashed(true);
      processed++;
    }
  }

  if (processed === 0) {
    return { status: "no_images", message: "⚠️ No screenshots found in folder." };
  }

  const parsedData = extractAndAppendBalances(allText);
  return { status: "success", data: parsedData };
}

function extractAndAppendBalances(text) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let helper = ss.getSheetByName("BALANCES");
  if (!helper) helper = ss.insertSheet("BALANCES");

  const today = new Date();

  // OCR cleanup
  text = text.replace(/\*/g, "₹");
  const lines = text.split("\n").map(l => l.trim()).filter(l => l);

  // Banks in screen order
  const banks = [
    { key: "IDBI", regex: /idbi/i },
    { key: "INDIAN", regex: /indian/i },
    { key: "FEDERAL", regex: /federal/i },
    { key: "ICICI", regex: /icici/i },
    { key: "CUB", regex: /city/i },
    { key: "KOTAK", regex: /kotak/i }
  ];

  const detectedBanks = [];
  for (const line of lines) {
    for (const bank of banks) {
      if (bank.regex.test(line)) {
        detectedBanks.push(bank.key);
        break;
      }
    }
  }

  const detectedAmounts = [];
  for (const line of lines) {
    const amtMatch = line.match(/([0-9,]+\.[0-9]+)/);
    if (amtMatch) {
      detectedAmounts.push(Math.round(parseFloat(amtMatch[1].replace(/,/g, ""))));
    }
  }

  // Map sequentially
  const result = {};
  for (let i = 0; i < detectedBanks.length; i++) {
    result[detectedBanks[i]] = detectedAmounts[i] || "";
  }

  // Write row
  helper.appendRow([
    today,
    result["KOTAK"] || "",
    result["IDBI"] || "",
    result["FEDERAL"] || "",
    result["CUB"] || "",
    result["INDIAN"] || "",
    result["ICICI"] || ""
  ]);

  return result;
}

function jsonResponse(status, message) {
  return ContentService
    .createTextOutput(JSON.stringify({ status, message }))
    .setMimeType(ContentService.MimeType.JSON);
}