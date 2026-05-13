import os

search_dir = '.'
pattern = '.filename'

for root, dirs, files in os.walk(search_dir):
    for file in files:
        if file.endswith('.py'):
            filepath = os.path.join(root, file)
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    for i, line in enumerate(f):
                        if pattern in line:
                            print(f"{filepath}:{i+1}: {line.strip()}")
            except Exception as e:
                pass
