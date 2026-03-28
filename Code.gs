// ═══════════════════════════════════════════════════════════════
// ResortDesk — Google Apps Script Backend
// ═══════════════════════════════════════════════════════════════
//
// SETUP INSTRUCTIONS:
// 1. Create a new Google Spreadsheet called "ResortDesk Registry"
// 2. Paste this entire script into Apps Script (Extensions → Apps Script)
// 3. Run setupRegistry() once to create all required sheets
// 4. Deploy as Web App → Execute as: Me → Who has access: Anyone
// 5. Copy the Web App URL — you'll need it in login.html
//
// SHEET STRUCTURE (auto-created by setupRegistry()):
//   "Registry"   — one row per hotel (id, name, passwords, plan, etc.)
//   "hotel_id"   — guest data for each hotel (auto-created on first check-in)
//   "ActivityLog"— every login and action logged here
// ═══════════════════════════════════════════════════════════════

var REGISTRY_SHEET = 'Registry';
var LOG_SHEET      = 'ActivityLog';
var FREE_LIMIT     = 50; // max check-ins on free plan

// ── CORS helper ───────────────────────────────────────────────
function corsResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── SETUP: run this once manually to create sheet structure ───
function setupRegistry() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Create Registry sheet
  var reg = ss.getSheetByName(REGISTRY_SHEET);
  if (!reg) {
    reg = ss.insertSheet(REGISTRY_SHEET);
    reg.appendRow([
      'Hotel ID', 'Hotel Name', 'Location', 'Phone',
      'Admin Password', 'Staff PIN', 'Plan', 'Sheet URL',
      'Drive Folder ID', 'Active', 'Created At', 'Check-In Count'
    ]);
    reg.getRange(1, 1, 1, 12).setFontWeight('bold').setBackground('#C9A84C').setFontColor('#000');

    // Add Mykonos as first hotel
    reg.appendRow([
      'mykonos',
      'Mykonos Cottage Tarkarli',
      'Devbag, Tarkarli, Malvan, Maharashtra',
      '+91 8850076039',
      'mykonos@admin',
      '1234',
      'pro',
      '', // their sheet URL — fill this in
      '1mYN-gGbT6J1qz0JKBPR_4uarjR0mm7vN',
      'true',
      new Date().toLocaleString('en-IN'),
      0
    ]);
  }

  // Create Activity Log sheet
  var log = ss.getSheetByName(LOG_SHEET);
  if (!log) {
    log = ss.insertSheet(LOG_SHEET);
    log.appendRow(['Timestamp', 'Hotel ID', 'User Name', 'Role', 'Action', 'Details', 'IP']);
    log.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#161B22').setFontColor('#fff');
  }

  return 'Setup complete! Registry and ActivityLog sheets created.';
}

// ═══════════════════════════════════════════════════════════════
// GET — handles: login check, load guests, get hotel info
// ═══════════════════════════════════════════════════════════════
function doGet(e) {
  try {
    var action  = e.parameter.action  || 'guests';
    var hotelId = e.parameter.hotelId || '';

    // ── 1. Validate hotel (used on page load to show hotel name) ──
    if (action === 'hotelInfo') {
      var hotel = getHotelFromRegistry(hotelId);
      if (!hotel) return corsResponse({ status: 'error', message: 'Invalid hotel ID' });
      return corsResponse({
        status:   'success',
        name:     hotel.name,
        location: hotel.location,
        phone:    hotel.phone,
        plan:     hotel.plan,
      });
    }

    // ── 2. Login check ──────────────────────────────────────────
    if (action === 'login') {
      var hotel    = getHotelFromRegistry(hotelId);
      if (!hotel)          return corsResponse({ status: 'error', message: 'Invalid hotel ID' });
      if (hotel.active !== 'true') return corsResponse({ status: 'error', message: 'Account suspended. Contact ResortDesk support.' });

      var role     = e.parameter.role     || '';
      var password = e.parameter.password || '';
      var userName = e.parameter.name     || role;

      var valid = false;
      if (role === 'admin' && password === hotel.adminPassword) valid = true;
      if (role === 'staff' && password === hotel.staffPin)      valid = true;

      if (!valid) {
        logActivity(hotelId, userName, role, 'FAILED_LOGIN', 'Wrong credentials');
        return corsResponse({ status: 'error', message: 'Wrong password. Please try again.' });
      }

      logActivity(hotelId, userName, role, 'LOGIN', 'Successful login');
      return corsResponse({
        status:    'success',
        role:      role,
        name:      hotel.name,
        location:  hotel.location,
        phone:     hotel.phone,
        plan:      hotel.plan,
        sheetUrl:  hotel.sheetUrl,
        loginTime: new Date().toISOString(),
      });
    }

    // ── 3. Load guests for a hotel ──────────────────────────────
    if (action === 'guests') {
      if (!hotelId) return corsResponse({ status: 'error', message: 'No hotel ID' });
      var data = getGuestsForHotel(hotelId);
      return corsResponse({ status: 'success', data: data });
    }

    return corsResponse({ status: 'error', message: 'Unknown action' });

  } catch(err) {
    return corsResponse({ status: 'error', message: err.toString() });
  }
}

// ═══════════════════════════════════════════════════════════════
// POST — handles: new check-in, checkout, update, delete
// ═══════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    var data    = JSON.parse(e.postData.contents);
    var hotelId = data.hotelId || '';
    var action  = data.action  || 'checkin';

    if (!hotelId) return corsResponse({ status: 'error', message: 'No hotel ID provided' });

    var hotel = getHotelFromRegistry(hotelId);
    if (!hotel) return corsResponse({ status: 'error', message: 'Invalid hotel ID' });

    // ── Free plan check-in limit ────────────────────────────────
    if (action === 'checkin' && hotel.plan === 'free') {
      var count = parseInt(hotel.checkinCount) || 0;
      if (count >= FREE_LIMIT) {
        return corsResponse({
          status:  'limit',
          message: 'Free plan limit reached (' + FREE_LIMIT + ' check-ins). Please upgrade to Pro.',
        });
      }
      incrementCheckinCount(hotelId);
    }

    // ── Route actions ───────────────────────────────────────────
    if (action === 'checkin') {
      saveNewGuest(hotelId, data);
      logActivity(hotelId, data.registeredBy || 'staff', data.registeredByRole || 'staff', 'CHECK_IN', data.guestId + ' — ' + data.firstName + ' ' + data.lastName);
      return corsResponse({ status: 'success' });
    }

    if (action === 'checkout') {
      updateGuestStatus(hotelId, data.guestId, 'Checked Out');
      logActivity(hotelId, data.doneBy || 'staff', 'staff', 'CHECK_OUT', data.guestId);
      return corsResponse({ status: 'success' });
    }

    if (action === 'update') {
      updateGuestRow(hotelId, data);
      logActivity(hotelId, data.updatedBy || 'staff', 'staff', 'UPDATE', data.guestId);
      return corsResponse({ status: 'success' });
    }

    if (action === 'delete') {
      deleteGuestRow(hotelId, data.guestId);
      logActivity(hotelId, data.deletedBy || 'admin', 'admin', 'DELETE', data.guestId);
      return corsResponse({ status: 'success' });
    }

    return corsResponse({ status: 'error', message: 'Unknown action' });

  } catch(err) {
    return corsResponse({ status: 'error', message: err.toString() });
  }
}

// ═══════════════════════════════════════════════════════════════
// REGISTRY HELPERS
// ═══════════════════════════════════════════════════════════════
function getHotelFromRegistry(hotelId) {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var reg  = ss.getSheetByName(REGISTRY_SHEET);
  if (!reg) return null;
  var rows = reg.getDataRange().getValues();
  var h    = rows[0]; // headers

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (String(row[h.indexOf('Hotel ID')]) === String(hotelId)) {
      return {
        id:             row[h.indexOf('Hotel ID')],
        name:           row[h.indexOf('Hotel Name')],
        location:       row[h.indexOf('Location')],
        phone:          row[h.indexOf('Phone')],
        adminPassword:  row[h.indexOf('Admin Password')],
        staffPin:       row[h.indexOf('Staff PIN')],
        plan:           String(row[h.indexOf('Plan')]).toLowerCase(),
        sheetUrl:       row[h.indexOf('Sheet URL')],
        driveFolderId:  row[h.indexOf('Drive Folder ID')],
        active:         String(row[h.indexOf('Active')]),
        checkinCount:   row[h.indexOf('Check-In Count')],
        rowIndex:       i + 1,
      };
    }
  }
  return null;
}

function incrementCheckinCount(hotelId) {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var reg  = ss.getSheetByName(REGISTRY_SHEET);
  var rows = reg.getDataRange().getValues();
  var h    = rows[0];
  var countCol = h.indexOf('Check-In Count') + 1;
  var idCol    = h.indexOf('Hotel ID');

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][idCol]) === String(hotelId)) {
      var current = parseInt(rows[i][countCol - 1]) || 0;
      reg.getRange(i + 1, countCol).setValue(current + 1);
      return;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// GUEST DATA — each hotel has its own sheet named by hotel ID
// ═══════════════════════════════════════════════════════════════
var GUEST_HEADERS = [
  'Guest ID','First Name','Last Name','Phone','City',
  'Check-In','Check-Out','Room','Booking Source','Adults','Children',
  'Purpose','ID Type','ID Number','Total Amount','Advance Paid',
  'Balance Due','Payment Mode','Payment Status','Transaction No',
  'Special Requests','Staff Notes','Registered At','Registered By',
  'Status','ID Front','ID Back'
];

function getOrCreateHotelSheet(hotelId) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(hotelId);
  if (!sheet) {
    sheet = ss.insertSheet(hotelId);
    sheet.appendRow(GUEST_HEADERS);
    sheet.getRange(1, 1, 1, GUEST_HEADERS.length).setFontWeight('bold').setBackground('#1C2333').setFontColor('#C9A84C');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getGuestsForHotel(hotelId) {
  var sheet = getOrCreateHotelSheet(hotelId);
  var rows  = sheet.getDataRange().getValues();
  if (rows.length <= 1) return [];

  var headers = rows[0];
  var data    = [];

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!row[0]) continue;
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = row[j] !== undefined ? String(row[j]) : '';
    }
    data.push({
      guestId:      obj['Guest ID']        || '',
      firstName:    obj['First Name']      || '',
      lastName:     obj['Last Name']       || '',
      phone:        obj['Phone']           || '',
      city:         obj['City']            || '',
      checkIn:      obj['Check-In']        || '',
      checkOut:     obj['Check-Out']       || '',
      room:         obj['Room']            || '',
      source:       obj['Booking Source']  || '',
      adults:       obj['Adults']          || '1',
      children:     obj['Children']        || '0',
      purpose:      obj['Purpose']         || '',
      idType:       obj['ID Type']         || '',
      idNumber:     obj['ID Number']       || '',
      amount:       obj['Total Amount']    || '0',
      advance:      obj['Advance Paid']    || '0',
      balance:      obj['Balance Due']     || '0',
      payMode:      obj['Payment Mode']    || '',
      payStatus:    obj['Payment Status']  || '',
      txnId:        obj['Transaction No']  || '',
      requests:     obj['Special Requests']|| '',
      notes:        obj['Staff Notes']     || '',
      registeredAt: obj['Registered At']   || '',
      registeredBy: obj['Registered By']   || '',
      status:       obj['Status']          || 'Checked In',
      idFront:      obj['ID Front']        || '',
      idBack:       obj['ID Back']         || '',
    });
  }
  return data;
}

function saveNewGuest(hotelId, data) {
  var sheet = getOrCreateHotelSheet(hotelId);

  // Save ID images to Drive if provided
  var frontUrl = '', backUrl = '';
  var hotel = getHotelFromRegistry(hotelId);
  if (hotel && hotel.driveFolderId) {
    if (data.idFront && data.idFront.length > 100) {
      frontUrl = saveImageToDrive(data.idFront, data.guestId + '_Front.jpg', hotel.driveFolderId);
    }
    if (data.idBack && data.idBack.length > 100) {
      backUrl = saveImageToDrive(data.idBack, data.guestId + '_Back.jpg', hotel.driveFolderId);
    }
  }

  sheet.appendRow([
    data.guestId, data.firstName, data.lastName, data.phone, data.city || '',
    data.checkIn, data.checkOut, data.room, data.source || '',
    data.adults, data.children, data.purpose || '',
    data.idType, data.idNumber,
    data.amount || 0, data.advance || 0, data.balance || 0,
    data.payMode || '', data.payStatus || '', data.txnId || '',
    data.requests || '', data.notes || '',
    data.registeredAt, data.registeredBy || '',
    'Checked In',
    frontUrl || (data.idFront && data.idFront.length < 100 ? data.idFront : ''),
    backUrl  || (data.idBack  && data.idBack.length  < 100 ? data.idBack  : ''),
  ]);
}

function updateGuestRow(hotelId, data) {
  var sheet   = getOrCreateHotelSheet(hotelId);
  var rows    = sheet.getDataRange().getValues();
  var headers = rows[0];
  var idCol   = headers.indexOf('Guest ID');

  var fieldMap = {
    'First Name': data.firstName, 'Last Name': data.lastName,
    'Phone': data.phone, 'City': data.city || '',
    'Check-In': data.checkIn, 'Check-Out': data.checkOut,
    'Room': data.room, 'Booking Source': data.source || '',
    'Adults': data.adults, 'Children': data.children,
    'Purpose': data.purpose || '', 'ID Type': data.idType || '',
    'ID Number': data.idNumber || '',
    'Total Amount': data.amount || 0, 'Advance Paid': data.advance || 0,
    'Balance Due': data.balance || 0, 'Payment Mode': data.payMode || '',
    'Payment Status': data.payStatus || '', 'Transaction No': data.txnId || '',
    'Special Requests': data.requests || '', 'Staff Notes': data.notes || '',
    'Status': data.status || 'Checked In',
  };

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][idCol]) === String(data.guestId)) {
      var newRow = headers.map(function(h) {
        return fieldMap.hasOwnProperty(h) ? fieldMap[h] : rows[i][headers.indexOf(h)];
      });
      sheet.getRange(i + 1, 1, 1, newRow.length).setValues([newRow]);
      return;
    }
  }
}

function updateGuestStatus(hotelId, guestId, newStatus) {
  var sheet   = getOrCreateHotelSheet(hotelId);
  var rows    = sheet.getDataRange().getValues();
  var headers = rows[0];
  var idCol   = headers.indexOf('Guest ID');
  var stCol   = headers.indexOf('Status');

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][idCol]) === String(guestId)) {
      sheet.getRange(i + 1, stCol + 1).setValue(newStatus);
      return;
    }
  }
}

function deleteGuestRow(hotelId, guestId) {
  var sheet   = getOrCreateHotelSheet(hotelId);
  var rows    = sheet.getDataRange().getValues();
  var headers = rows[0];
  var idCol   = headers.indexOf('Guest ID');

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][idCol]) === String(guestId)) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// DRIVE IMAGE UPLOAD
// ═══════════════════════════════════════════════════════════════
function saveImageToDrive(base64Data, fileName, folderId) {
  try {
    var base64 = base64Data.split(',')[1];
    var bytes  = Utilities.base64Decode(base64);
    var blob   = Utilities.newBlob(bytes, 'image/jpeg', fileName);
    var folder = DriveApp.getFolderById(folderId);
    var file   = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch(err) {
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════
// ACTIVITY LOG
// ═══════════════════════════════════════════════════════════════
function logActivity(hotelId, userName, role, action, details) {
  try {
    var ss  = SpreadsheetApp.getActiveSpreadsheet();
    var log = ss.getSheetByName(LOG_SHEET);
    if (!log) return;
    log.appendRow([
      new Date().toLocaleString('en-IN'),
      hotelId, userName, role, action, details, ''
    ]);
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════
// UTILITY: generate unique guest ID
// (call from client — but also available server-side)
// ═══════════════════════════════════════════════════════════════
function generateGuestId(hotelId) {
  var now = new Date();
  var y   = now.getFullYear();
  var m   = String(now.getMonth() + 1).padStart(2, '0');
  var d   = String(now.getDate()).padStart(2, '0');
  var uid = Math.random().toString(36).substr(2, 4).toUpperCase();
  return hotelId.toUpperCase().substr(0, 3) + '-' + y + m + d + '-' + uid;
}
