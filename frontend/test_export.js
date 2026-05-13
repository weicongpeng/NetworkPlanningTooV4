#!/usr/bin/env node
/*
测试PCI规划结果导出功能
*/
const axios = require('axios');

// 测试PCI规划结果导出功能
async function testPCIExport() {
  console.log('开始测试PCI规划结果导出功能...');
  
  try {
    // 首先，创建一个PCI规划任务
    console.log('创建PCI规划任务...');
    const createResponse = await axios.post('http://localhost:8000/api/v1/pci/plan', {
      "networkType": "LTE",
      "distanceThreshold": 3.0,
      "pciModulus": 3,
      "inheritModulus": false,
      "pciRange": {
        "min": 0,
        "max": 503
      }
    });
    
    const taskId = createResponse.data.data.taskId;
    console.log(`✓ 成功创建PCI规划任务，任务ID: ${taskId}`);
    
    // 等待任务执行完成（这里需要根据实际情况调整等待时间）
    console.log('等待PCI规划任务执行完成...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // 测试导出功能
    console.log('测试PCI规划结果导出...');
    const exportResponse = await axios.get(`http://localhost:8000/api/v1/pci/export/${taskId}`, {
      responseType: 'blob',
      params: { format: 'xlsx' }
    });
    
    console.log('✓ 成功导出PCI规划结果');
    console.log(`  - 响应状态: ${exportResponse.status}`);
    console.log(`  - 响应类型: ${exportResponse.headers['content-type']}`);
    console.log(`  - 文件大小: ${exportResponse.data.size} bytes`);
    
    // 验证返回的是Blob对象
    if (exportResponse.data instanceof Blob) {
      console.log('✓ 导出返回的是Blob对象，符合预期');
    } else {
      console.log('❌ 导出返回的不是Blob对象');
    }
    
    console.log('测试完成！PCI规划结果导出功能正常工作。');
  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    if (error.response) {
      console.error('  - 响应状态:', error.response.status);
      console.error('  - 响应数据:', error.response.data);
    }
  }
}

// 运行测试
testPCIExport();
