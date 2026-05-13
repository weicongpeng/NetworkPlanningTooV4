#!/bin/bash
# 运行测试脚本

echo "运行测试..."

# 运行后端测试
echo "运行后端测试..."
cd backend
python -m pytest tests/ -v

# 运行前端测试
echo "运行前端测试..."
cd ../frontend
npm test

echo "测试完成!"
