import re
import os

filepath = 'app/services/data_service.py'
if os.path.exists(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.readlines()
        for i, line in enumerate(content):
            if '.filename' in line:
                print(f"Line {i+1}: {line.strip()}")
else:
    print(f"File not found: {filepath}")
