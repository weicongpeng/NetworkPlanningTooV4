#!/bin/bash
# 前端构建脚本

echo "开始构建前端..."

# 检查Node.js版本
node_version=$(node --version)
echo "Node.js版本: $node_version"

# 安装依赖
echo "安装npm依赖..."
cd frontend
npm install

# 构建前端
echo "构建前端应用..."
npm run build

echo "前端构建完成!"
