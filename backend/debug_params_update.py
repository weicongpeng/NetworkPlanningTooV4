
import pandas as pd
from pathlib import Path
import os
import warnings

warnings.simplefilter(action='ignore', category=FutureWarning)
warnings.simplefilter(action='ignore', category=pd.errors.DtypeWarning)

DATA_DIR = Path("data")

def debug_lte_update(data_dir):
    print(f"\nScanning LTE files in {data_dir}...")
    patterns = ["LTE_SDR_CellInfo_*.csv", "LTE_ITBBU_CellInfo_*.csv"]
    files = []
    for pat in patterns:
        files.extend(list(data_dir.glob(pat)))
        files.extend(list(data_dir.glob(f"**/{pat}")))
    
    print(f"Found {len(files)} LTE CSVs")
    
    target_enb = 936509
    target_cell = 19
    
    for file_path in files:
        try:
            try:
                df = pd.read_csv(file_path, encoding='gbk')
            except:
                df = pd.read_csv(file_path, encoding='utf-8')
            
            df.columns = [c.strip() for c in df.columns]
            
            # Check if target exists
            if 'eNBId' in df.columns and 'cellLocalId' in df.columns:
                match = df[(df['eNBId'] == target_enb) & (df['cellLocalId'] == target_cell)]
                if not match.empty:
                    print(f"\n[FOUND] LTE Match in {file_path.name}:")
                    row = match.iloc[0].to_dict()
                    print(f"Available Columns: {list(row.keys())}")
                    # Print specific values
                    for k in ['eNBName', 'cellName', 'CellName', 'UserLabel', 'SubNetwork', 'ManagedElement']:
                        if k in row:
                            print(f"  {k}: {row[k]}")

        except Exception as e:
            pass

def debug_nr_update(data_dir):
    print(f"\nScanning NR files in {data_dir}...")
    patterns = ["NR_CellInfo_*.csv"]
    files = []
    for pat in patterns:
        files.extend(list(data_dir.glob(pat)))
        files.extend(list(data_dir.glob(f"**/{pat}")))
        
    print(f"Found {len(files)} NR CSVs")
    
    # Target: 460+11+7906619+1601
    target_gnb = 7906619
    target_cell = 1601
    
    for file_path in files:
        try:
            try:
                df = pd.read_csv(file_path, encoding='gbk')
            except:
                df = pd.read_csv(file_path, encoding='utf-8')
            
            df.columns = [c.strip() for c in df.columns]
            
            for idx, row in df.iterrows():
                item = row.to_dict()
                if item.get('gNBId') == target_gnb and item.get('cellLocalId') == target_cell:
                     print(f"\n[FOUND] NR Match in {file_path.name}:")
                     print(f"Available Columns: {list(item.keys())}")
                     for k in ['eNBName', 'gNBName', 'cellName', 'CellName', 'UserLabel', 'frequencyBandList', 'gNodeBLength']:
                         if k in item:
                             print(f"  {k}: {item[k]}")
                             
        except Exception as e:
            pass


if __name__ == "__main__":
    # We need to find the directory where the current params were unzipped.
    # From previous history, we saw a map file.
    # Let's iterate all dirs in data/
    import sys
    
    all_dirs = [d for d in DATA_DIR.iterdir() if d.is_dir()]
    print(f"Scanning {len(all_dirs)} directories in data/...")
    
    for d in all_dirs:
        debug_lte_update(d)
        debug_nr_update(d)
