import re

with open('app/services/data_service.py', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f):
        if 'file.filename' in line:
            print(f"L{i+1}: {line.strip()}")
