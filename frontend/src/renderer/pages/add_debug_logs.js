const fs = require('fs');

// 读取文件
let content = fs.readFileSync('PCIPage.tsx', 'utf8');

// 在handleResultRowClick方法中，在白名单设置后添加详细的调试日志
// 查找"构建白名单：只渲染选中的扇区和同频同PCI的扇区"这一行
const whitelistSectionRegex = /(\/\/ 构建白名单：只渲染选中的扇区和同频同PCI的扇区\s*\/\/ 使用实际的sector\.id而不是构造的ID\s*const whitelist = new Set<string>\(\[selectedSectorId, \.\.\.relatedIds\]\)\s*console\.log\('\[PCIPage\] 设置扇区白名单', \{\s*count: whitelist\.size,\s*selectedId: selectedSectorId,\s*ids: Array\.from\(whitelist\)\.slice\(0, 10\)\s*\}\))/;

if (whitelistSectionRegex.test(content)) {
  content = content.replace(whitelistSectionRegex, `// 构建白名单：只渲染选中的扇区和同频同PCI的扇区
    // 使用实际的sector.id而不是构造的ID
    const whitelist = new Set<string>([selectedSectorId, ...relatedIds])
    
    // 获取所有同步数据的ID用于验证
    const syncedData = pciDataSyncService.getSyncedData()
    const allSyncedIds = syncedData ? 
      [...syncedData.lte, ...syncedData.nr].map(s => s.id) : []
    
    // 验证白名单中的ID是否在同步数据中存在
    const missingIds = Array.from(whitelist).filter(id => !allSyncedIds.includes(id))
    
    console.log('[PCIPage] 设置扇区白名单 - 详细验证', {
      count: whitelist.size,
      selectedId: selectedSectorId,
      selectedIdInSyncedData: allSyncedIds.includes(selectedSectorId),
      relatedIds: relatedIds,
      relatedIdsInSyncedData: relatedIds.map(id => ({
        id,
        exists: allSyncedIds.includes(id)
      })),
      allIds: Array.from(whitelist),
      totalSyncedIds: allSyncedIds.length,
      missingIds: missingIds,
      whitelistSample: Array.from(whitelist).slice(0, 10),
      syncedDataSample: allSyncedIds.slice(0, 10)
    })`);
  
  console.log('✓ 已在PCIPage.tsx中添加白名单详细验证日志');
} else {
  console.log('✗ 未找到目标代码块，跳过修改');
}

// 在handleResultRowClick方法中，在找到同步扇区后添加更多调试信息
const findSectorRegex = /(\/\/ 查找同步后的扇区，验证是否找到\s*const syncedSector = pciDataSyncService\.findSector\(siteId, sectorId\)\s*console\.log\('\[PCIPage\] 查找同步后的扇区', \{\s*found: !!syncedSector,\s*sectorId: syncedSector\?\.id,\s*sectorName: syncedSector\?\.name,\s*syncedPCI: syncedSector\?\.syncedPCI\s*\}\))/;

if (findSectorRegex.test(content)) {
  content = content.replace(findSectorRegex, `// 查找同步后的扇区，验证是否找到
    const syncedSector = pciDataSyncService.findSector(siteId, sectorId)
    console.log('[PCIPage] 查找同步后的扇区', {
      found: !!syncedSector,
      sectorId: syncedSector?.id,
      sectorName: syncedSector?.name,
      syncedPCI: syncedSector?.syncedPCI,
      inputSiteId: siteId,
      inputSectorId: sectorId,
      actualSiteId: syncedSector?.siteId,
      actualSectorId: syncedSector?.sectorId,
      displayLat: syncedSector?.displayLat,
      displayLng: syncedSector?.displayLng
    })`);
  
  console.log('✓ 已在PCIPage.tsx中添加扇区查找详细日志');
} else {
  console.log('✗ 未找到扇区查找代码块，跳过修改');
}

// 写回文件
fs.writeFileSync('PCIPage.tsx', content, 'utf8');

console.log('✓ PCIPage.tsx 调试日志添加完成');
