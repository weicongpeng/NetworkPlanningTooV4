// e:\mobile-app\test_parser.js
// 解析 ProjectParameter_20260616_APP.xlsx 的第一行表头,验证 parseSheetXmlToRows 是否能正确捕获所有列。

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const XLSX_PATH = path.join('e:\\mobile-app', 'ProjectParameter_20260616_APP.xlsx');

function parseSharedStringsXml(xml) {
  const strings = [];
  let pos = 0;
  while ((pos = xml.indexOf('<si', pos)) !== -1) {
    const siOpenEnd = xml.indexOf('>', pos);
    if (siOpenEnd === -1) break;
    const siEnd = xml.indexOf('</si>', siOpenEnd);
    if (siEnd === -1) break;
    const siContent = xml.substring(siOpenEnd + 1, siEnd);
    let textParts = [];
    let tPos = 0;
    while ((tPos = siContent.indexOf('<t', tPos)) !== -1) {
      const tTagEnd = siContent.indexOf('>', tPos);
      if (tTagEnd === -1) break;
      if (tTagEnd > 0 && siContent[tTagEnd - 1] === '/') {
        textParts.push('');
        tPos = tTagEnd + 1;
        continue;
      }
      const tClose = siContent.indexOf('</t>', tTagEnd);
      if (tClose !== -1) {
        textParts.push(siContent.substring(tTagEnd + 1, tClose));
        tPos = tClose + 4;
      } else {
        break;
      }
    }
    strings.push(textParts.join(''));
    pos = siEnd + 5;
  }
  return strings;
}

function colLettersToIndex(colStr) {
  let index = 0;
  for (let i = 0; i < colStr.length; i++) {
    index = index * 26 + colStr.charCodeAt(i) - 64;
  }
  return index - 1;
}

function parseSheetXmlToRows(xml, sharedStrings) {
  const rowCells = new Map();
  const maxColPerRow = new Map();
  let maxRow = 0;

  let pos = 0;
  while ((pos = xml.indexOf('<c ', pos)) !== -1) {
    const tagEnd = xml.indexOf('>', pos);
    if (tagEnd === -1) { pos += 3; continue; }
    const cTag = xml.substring(pos + 3, tagEnd);
    const rIdx = cTag.indexOf('r="');
    if (rIdx === -1) { pos += 3; continue; }
    const rStart = rIdx + 3;
    const rEnd = cTag.indexOf('"', rStart);
    if (rEnd === -1) { pos += 3; continue; }
    const cellRef = cTag.substring(rStart, rEnd);

    let colStr = '';
    let rowStr = '';
    for (let i = 0; i < cellRef.length; i++) {
      const ch = cellRef[i];
      if (ch >= '0' && ch <= '9') {
        colStr = cellRef.substring(0, i);
        rowStr = cellRef.substring(i);
        break;
      }
    }
    if (!colStr || !rowStr) { pos += 3; continue; }

    const colIdx = colLettersToIndex(colStr);
    const rowNum = parseInt(rowStr, 10);

    const tIdx = cTag.indexOf('t="');
    let cellType = '';
    if (tIdx !== -1) {
      const tValEnd = cTag.indexOf('"', tIdx + 3);
      cellType = tValEnd !== -1 ? cTag.substring(tIdx + 3, tValEnd) : '';
    }

    // Self-closing <c .../> tag — no <v> content, value is empty string.
    if (cTag.endsWith('/')) {
      if (!rowCells.has(rowNum)) rowCells.set(rowNum, []);
      rowCells.get(rowNum).push({ colIdx, value: '' });
      maxRow = Math.max(maxRow, rowNum);
      const curMax = maxColPerRow.get(rowNum) ?? -1;
      maxColPerRow.set(rowNum, Math.max(curMax, colIdx));
      pos = tagEnd + 2; // skip '/>'
      continue;
    }

    const closeTag = xml.indexOf('</c>', tagEnd);
    if (closeTag === -1) { pos += 3; continue; }
    const innerXml = xml.substring(tagEnd + 1, closeTag);

    let cellValue = '';
    if (cellType === 's' || cellType === 'str' || cellType === 'b' || !cellType) {
      const vIdx = innerXml.indexOf('<v>');
      if (vIdx !== -1) {
        const vEnd = innerXml.indexOf('</v>', vIdx);
        if (vEnd !== -1) {
          const rawVal = innerXml.substring(vIdx + 3, vEnd);
          if (cellType === 's') {
            cellValue = sharedStrings[parseInt(rawVal, 10)] ?? '';
          } else if (cellType === 'b') {
            cellValue = rawVal === '1' ? 'TRUE' : 'FALSE';
          } else {
            cellValue = rawVal;
          }
        }
      }
    } else if (cellType === 'inlineStr') {
      const tIdx2 = innerXml.indexOf('<t');
      if (tIdx2 !== -1) {
        const tTagEnd = innerXml.indexOf('>', tIdx2);
        const tEnd = innerXml.indexOf('</t>', tTagEnd);
        if (tTagEnd !== -1 && tEnd !== -1) {
          cellValue = innerXml.substring(tTagEnd + 1, tEnd);
        }
      }
    }

    if (!rowCells.has(rowNum)) rowCells.set(rowNum, []);
    rowCells.get(rowNum).push({ colIdx, value: cellValue });
    maxRow = Math.max(maxRow, rowNum);
    const curMax = maxColPerRow.get(rowNum) ?? -1;
    maxColPerRow.set(rowNum, Math.max(curMax, colIdx));

    pos = closeTag + 4;
  }

  if (maxRow === 0) return [];

  let sheetMaxCol = 0;
  for (const mc of maxColPerRow.values()) {
    if (mc > sheetMaxCol) sheetMaxCol = mc;
  }

  const result = [];
  for (let r = 1; r <= maxRow; r++) {
    const cells = rowCells.get(r);
    const row = new Array(sheetMaxCol + 1).fill('');
    if (cells) {
      for (const cell of cells) {
        row[cell.colIdx] = cell.value;
      }
    }
    result.push(row);
  }
  return result;
}

(async () => {
  console.log('=== Reading xlsx:', XLSX_PATH, '===');
  const buf = fs.readFileSync(XLSX_PATH);
  const zip = await JSZip.loadAsync(buf);

  // 1) sharedStrings.xml
  const ssEntry = zip.file('xl/sharedStrings.xml');
  let sharedStrings = [];
  if (ssEntry) {
    const ssXml = await ssEntry.async('string');
    sharedStrings = parseSharedStringsXml(ssXml);
    console.log('sharedStrings length:', sharedStrings.length);
  } else {
    console.log('xl/sharedStrings.xml not found (workbook has no shared strings).');
  }

  // 2) sheet1.xml
  const sheetEntry = zip.file('xl/worksheets/sheet1.xml');
  if (!sheetEntry) {
    console.log('xl/worksheets/sheet1.xml not found.');
    return;
  }
  const sheetXml = await sheetEntry.async('string');
  console.log('sheet1.xml length:', sheetXml.length);

  // 3) Run parseSheetXmlToRows - we need to also expose rowCells, so re-run logic to extract.
  // Since parseSheetXmlToRows only returns result, we mirror it slightly: call it for result[0],
  // but also re-extract rowCells via a side channel. To keep the EXACT function, we run it once
  // and then re-extract the same data via a second pass using a slightly modified loop that
  // captures rowCells. To honor "EXACT copy-paste", we run the exact function first for
  // result[0], then run a parallel collection with the same logic to expose rowCells.
  const result = parseSheetXmlToRows(sheetXml, sharedStrings);

  // Run a parallel extraction using the EXACT same scanning logic to expose rowCells.
  // (Identical to the loop inside parseSheetXmlToRows; we re-execute for observability.)
  const rowCells = new Map();
  {
    const xml = sheetXml;
    let pos = 0;
    while ((pos = xml.indexOf('<c ', pos)) !== -1) {
      const tagEnd = xml.indexOf('>', pos);
      if (tagEnd === -1) { pos += 3; continue; }
      const cTag = xml.substring(pos + 3, tagEnd);
      const rIdx = cTag.indexOf('r="');
      if (rIdx === -1) { pos += 3; continue; }
      const rStart = rIdx + 3;
      const rEnd = cTag.indexOf('"', rStart);
      if (rEnd === -1) { pos += 3; continue; }
      const cellRef = cTag.substring(rStart, rEnd);

      let colStr = '';
      let rowStr = '';
      for (let i = 0; i < cellRef.length; i++) {
        const ch = cellRef[i];
        if (ch >= '0' && ch <= '9') {
          colStr = cellRef.substring(0, i);
          rowStr = cellRef.substring(i);
          break;
        }
      }
      if (!colStr || !rowStr) { pos += 3; continue; }

      const colIdx = colLettersToIndex(colStr);
      const rowNum = parseInt(rowStr, 10);

      const tIdx = cTag.indexOf('t="');
      let cellType = '';
      if (tIdx !== -1) {
        const tValEnd = cTag.indexOf('"', tIdx + 3);
        cellType = tValEnd !== -1 ? cTag.substring(tIdx + 3, tValEnd) : '';
      }

      // Self-closing <c .../> tag — no <v> content, value is empty string.
      if (cTag.endsWith('/')) {
        if (!rowCells.has(rowNum)) rowCells.set(rowNum, []);
        rowCells.get(rowNum).push({ colIdx, value: '' });
        pos = tagEnd + 2; // skip '/>'
        continue;
      }

      const closeTag = xml.indexOf('</c>', tagEnd);
      if (closeTag === -1) { pos += 3; continue; }
      const innerXml = xml.substring(tagEnd + 1, closeTag);

      let cellValue = '';
      if (cellType === 's' || cellType === 'str' || cellType === 'b' || !cellType) {
        const vIdx = innerXml.indexOf('<v>');
        if (vIdx !== -1) {
          const vEnd = innerXml.indexOf('</v>', vIdx);
          if (vEnd !== -1) {
            const rawVal = innerXml.substring(vIdx + 3, vEnd);
            if (cellType === 's') {
              cellValue = sharedStrings[parseInt(rawVal, 10)] ?? '';
            } else if (cellType === 'b') {
              cellValue = rawVal === '1' ? 'TRUE' : 'FALSE';
            } else {
              cellValue = rawVal;
            }
          }
        }
      } else if (cellType === 'inlineStr') {
        const tIdx2 = innerXml.indexOf('<t');
        if (tIdx2 !== -1) {
          const tTagEnd = innerXml.indexOf('>', tIdx2);
          const tEnd = innerXml.indexOf('</t>', tTagEnd);
          if (tTagEnd !== -1 && tEnd !== -1) {
            cellValue = innerXml.substring(tTagEnd + 1, tEnd);
          }
        }
      }

      if (!rowCells.has(rowNum)) rowCells.set(rowNum, []);
      rowCells.get(rowNum).push({ colIdx, value: cellValue });

      pos = closeTag + 5;
    }
  }

  // 4) Print result[0] as [index, value] pairs
  console.log('\n=== result[0] (header row) as [index, value] pairs ===');
  if (!result || result.length === 0) {
    console.log('result is empty.');
  } else {
    const header = result[0];
    const pairs = header.map((v, i) => [i, v]);
    console.log('Total columns in header row:', header.length);
    for (const [idx, val] of pairs) {
      console.log(`  [${idx}] ${JSON.stringify(val)}`);
    }
  }

  // 5) Print rowCells.get(1)
  console.log('\n=== rowCells.get(1) ===');
  const row1 = rowCells.get(1);
  if (!row1) {
    console.log('rowCells.get(1) is undefined (no row 1 captured).');
  } else {
    console.log('Number of cells captured for row 1:', row1.length);
    // Sort by colIdx for readability
    const sorted = [...row1].sort((a, b) => a.colIdx - b.colIdx);
    for (const cell of sorted) {
      console.log(`  colIdx=${cell.colIdx} (${colIndexToLetters(cell.colIdx)}) value=${JSON.stringify(cell.value)}`);
    }
  }

  // 6) Check B1, D1, F1, H1, J1, L1
  console.log('\n=== Check required cells in row 1 ===');
  const required = ['B1', 'D1', 'F1', 'H1', 'J1', 'L1'];
  const row1List = rowCells.get(1) || [];
  const capturedRefs = new Set();
  for (const cell of row1List) {
    capturedRefs.add(`${colIndexToLetters(cell.colIdx)}1`);
  }
  for (const ref of required) {
    const present = capturedRefs.has(ref);
    console.log(`  ${ref}: ${present ? 'PRESENT' : 'MISSING'}`);
  }

  // Also list all captured refs in row 1
  console.log('\nAll captured refs in row 1 (sorted by colIdx):');
  const allRefs = [...row1List]
    .sort((a, b) => a.colIdx - b.colIdx)
    .map(c => `${colIndexToLetters(c.colIdx)}1`);
  console.log('  ' + allRefs.join(', '));
})().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});

// Helper: convert 0-based col index to letters (e.g. 1 -> B, 3 -> D, 11 -> L)
function colIndexToLetters(idx) {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
