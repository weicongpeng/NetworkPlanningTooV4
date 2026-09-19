// Verify hypothesis: pos = closeTag + 5 vs pos = closeTag + 4
const fs = require('fs');
const JSZip = require('jszip');

function colLettersToIndex(colStr) {
  let index = 0;
  for (let i = 0; i < colStr.length; i++) {
    index = index * 26 + colStr.charCodeAt(i) - 64;
  }
  return index - 1;
}

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
      } else break;
    }
    strings.push(textParts.join(''));
    pos = siEnd + 5;
  }
  return strings;
}

(async () => {
  const buf = fs.readFileSync('e:\\mobile-app\\ProjectParameter_20260616_APP.xlsx');
  const zip = await JSZip.loadAsync(buf);
  const ssXml = await (await zip.file('xl/sharedStrings.xml').async('string'));
  const sharedStrings = parseSharedStringsXml(ssXml);
  const sheetXml = await (await zip.file('xl/worksheets/sheet1.xml').async('string'));

  // Original: pos = closeTag + 5
  const rowCells1 = new Map();
  let pos = 0;
  while ((pos = sheetXml.indexOf('<c ', pos)) !== -1) {
    const tagEnd = sheetXml.indexOf('>', pos);
    if (tagEnd === -1) { pos += 3; continue; }
    const cTag = sheetXml.substring(pos + 3, tagEnd);
    const rIdx = cTag.indexOf('r="');
    if (rIdx === -1) { pos += 3; continue; }
    const cellRef = cTag.substring(rIdx + 3, cTag.indexOf('"', rIdx + 3));
    const m = cellRef.match(/^([A-Z]+)(\d+)$/);
    if (!m) { pos += 3; continue; }
    const colIdx = colLettersToIndex(m[1]);
    const rowNum = parseInt(m[2], 10);

    const tIdx = cTag.indexOf('t="');
    let cellType = tIdx === -1 ? '' : (() => { const e = cTag.indexOf('"', tIdx + 3); return e !== -1 ? cTag.substring(tIdx + 3, e) : ''; })();

    if (cTag.endsWith('/')) {
      if (!rowCells1.has(rowNum)) rowCells1.set(rowNum, []);
      rowCells1.get(rowNum).push({ colIdx, value: '' });
      pos = tagEnd + 2;
      continue;
    }
    const closeTag = sheetXml.indexOf('</c>', tagEnd);
    if (closeTag === -1) { pos += 3; continue; }
    const innerXml = sheetXml.substring(tagEnd + 1, closeTag);
    let cellValue = '';
    if (cellType === 's' || cellType === 'str' || cellType === 'b' || !cellType) {
      const vIdx = innerXml.indexOf('<v>');
      if (vIdx !== -1) {
        const vEnd = innerXml.indexOf('</v>', vIdx);
        if (vEnd !== -1) {
          const rawVal = innerXml.substring(vIdx + 3, vEnd);
          if (cellType === 's') cellValue = sharedStrings[parseInt(rawVal, 10)] ?? '';
          else if (cellType === 'b') cellValue = rawVal === '1' ? 'TRUE' : 'FALSE';
          else cellValue = rawVal;
        }
      }
    }
    if (!rowCells1.has(rowNum)) rowCells1.set(rowNum, []);
    rowCells1.get(rowNum).push({ colIdx, value: cellValue });
    pos = closeTag + 5;  // <-- ORIGINAL
  }

  // Fixed: pos = closeTag + 4
  const rowCells2 = new Map();
  pos = 0;
  while ((pos = sheetXml.indexOf('<c ', pos)) !== -1) {
    const tagEnd = sheetXml.indexOf('>', pos);
    if (tagEnd === -1) { pos += 3; continue; }
    const cTag = sheetXml.substring(pos + 3, tagEnd);
    const rIdx = cTag.indexOf('r="');
    if (rIdx === -1) { pos += 3; continue; }
    const cellRef = cTag.substring(rIdx + 3, cTag.indexOf('"', rIdx + 3));
    const m = cellRef.match(/^([A-Z]+)(\d+)$/);
    if (!m) { pos += 3; continue; }
    const colIdx = colLettersToIndex(m[1]);
    const rowNum = parseInt(m[2], 10);

    const tIdx = cTag.indexOf('t="');
    let cellType = tIdx === -1 ? '' : (() => { const e = cTag.indexOf('"', tIdx + 3); return e !== -1 ? cTag.substring(tIdx + 3, e) : ''; })();

    if (cTag.endsWith('/')) {
      if (!rowCells2.has(rowNum)) rowCells2.set(rowNum, []);
      rowCells2.get(rowNum).push({ colIdx, value: '' });
      pos = tagEnd + 2;
      continue;
    }
    const closeTag = sheetXml.indexOf('</c>', tagEnd);
    if (closeTag === -1) { pos += 3; continue; }
    const innerXml = sheetXml.substring(tagEnd + 1, closeTag);
    let cellValue = '';
    if (cellType === 's' || cellType === 'str' || cellType === 'b' || !cellType) {
      const vIdx = innerXml.indexOf('<v>');
      if (vIdx !== -1) {
        const vEnd = innerXml.indexOf('</v>', vIdx);
        if (vEnd !== -1) {
          const rawVal = innerXml.substring(vIdx + 3, vEnd);
          if (cellType === 's') cellValue = sharedStrings[parseInt(rawVal, 10)] ?? '';
          else if (cellType === 'b') cellValue = rawVal === '1' ? 'TRUE' : 'FALSE';
          else cellValue = rawVal;
        }
      }
    }
    if (!rowCells2.has(rowNum)) rowCells2.set(rowNum, []);
    rowCells2.get(rowNum).push({ colIdx, value: cellValue });
    pos = closeTag + 4;  // <-- FIXED (was +5)
  }

  console.log('=== ORIGINAL (pos = closeTag + 5) ===');
  console.log('rowCells.get(1) cells:', rowCells1.get(1).length);
  console.log('Captured refs:', rowCells1.get(1).map(c => c.colIdx).join(', '));

  console.log('\n=== FIXED (pos = closeTag + 4) ===');
  console.log('rowCells.get(1) cells:', rowCells2.get(1).length);
  console.log('Captured refs:', rowCells2.get(1).map(c => c.colIdx).join(', '));
})().catch(e => { console.error(e); process.exit(1); });
