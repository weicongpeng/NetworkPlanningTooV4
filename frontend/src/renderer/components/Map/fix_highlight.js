const fs = require('fs');

// 读取文件
let content = fs.readFileSync('SectorRendererSVG.tsx', 'utf8');

// 修复1：在_createSectorPolygon方法中增强选中扇区的红色高亮
content = content.replace(
  /if \(sector\.id === selectedId\) \{\s*\/\/ 选中的扇区：不透明红色，高对比度\s*fillColor = '#ef4444'\s*strokeColor = '#dc2626'\s*strokeWidth = 3/s,
  `if (sector.id === selectedId) {
        // 选中的扇区：不透明红色，高对比度
        fillColor = '#ff0000'  // 更亮的红色
        strokeColor = '#cc0000'  // 深红色边框
        strokeWidth = 6  // 更粗的边框`
);

// 修复2：在_createSectorPolygon方法中增强同频同PCI扇区的蓝色高亮（如果还没修改）
content = content.replace(
  /if \(relatedIdsSet\.has\(sector\.id\)\) \{\s*\/\/ 同频同PCI的扇区：不透明蓝色，高对比度\s*fillColor = '#3b82f6'\s*strokeColor = '#2563eb'\s*strokeWidth = 3/s,
  `if (relatedIdsSet.has(sector.id)) {
        // 同频同PCI的扇区：不透明蓝色，高对比度
        fillColor = '#0066ff'  // 更亮的蓝色
        strokeColor = '#0044cc'  // 深蓝色边框
        strokeWidth = 6  // 更粗的边框`
);

// 修复3：在_updateSectorStyles方法中增强选中扇区的红色高亮（多边形）
content = content.replace(
  /cached\.polygon\.setStyle\(\{\s*fillColor: '#ef4444',\s*color: '#dc2626',\s*weight: 3,/s,
  `cached.polygon.setStyle({
          fillColor: '#ff0000',  // 更亮的红色
          color: '#cc0000',  // 深红色边框
          weight: 6,  // 更粗的边框`
);

// 修复4：在_updateSectorStyles方法中增强同频同PCI扇区的蓝色高亮（多边形）
content = content.replace(
  /cached\.polygon\.setStyle\(\{\s*fillColor: '#3b82f6',\s*color: '#2563eb',\s*weight: 3,/s,
  `cached.polygon.setStyle({
          fillColor: '#0066ff',  // 更亮的蓝色
          color: '#0044cc',  // 深蓝色边框
          weight: 6,  // 更粗的边框`
);

// 修复5：在_updateSectorStyles方法中增强选中扇区的红色高亮（圆点）
content = content.replace(
  /cached\.marker\.setStyle\(\{\s*fillColor: '#ef4444',\s*color: '#dc2626',\s*weight: 3,/g,
  `cached.marker.setStyle({
          fillColor: '#ff0000',  // 更亮的红色
          color: '#cc0000',  // 深红色边框
          weight: 6,  // 更粗的边框`
);

// 修复6：在_updateSectorStyles方法中增强同频同PCI扇区的蓝色高亮（圆点）
content = content.replace(
  /cached\.marker\.setStyle\(\{\s*fillColor: '#3b82f6',\s*color: '#2563eb',\s*weight: 3,/g,
  `cached.marker.setStyle({
          fillColor: '#0066ff',  // 更亮的蓝色
          color: '#0044cc',  // 深蓝色边框
          weight: 6,  // 更粗的边框`
);

// 添加调试日志：在_updateSectorStyles方法开头添加详细日志
content = content.replace(
  /console\.log\('\[SectorRenderer\] 应用PCI高亮', \{/,
  `// 检查渲染模式
    console.log('[SectorRenderer] 应用PCI高亮 - 配置检查', {
      renderMode: this.renderMode,
      hasHighlightConfig: !!this.pciHighlightConfig,
      totalPolygons: this.sectorPolygons.size,
      totalMarkers: this.siteMarkers.size
    })

    console.log('[SectorRenderer] 应用PCI高亮', {`
);

// 添加调试日志：在PCIPage的handleResultRowClick中添加详细的白名单日志
// 这个需要单独处理，因为它是不同的文件

// 写回文件
fs.writeFileSync('SectorRendererSVG.tsx', content, 'utf8');

console.log('✓ SectorRendererSVG.tsx 高亮效果增强完成');
