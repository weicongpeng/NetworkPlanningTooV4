
import pandas as pd
import sys

file_path = r"d:\mycode\NetworkPlanningTooV2\待规划小区\cell-tree-export-20250915204721.xlsx"

try:
    xl = pd.ExcelFile(file_path)
    print(f"Sheet names: {xl.sheet_names}")
    for sheet in xl.sheet_names:
        print(f"\n--- Sheet: {sheet} ---")
        # Try reading with default header
        df = pd.read_excel(xl, sheet_name=sheet, nrows=5)
        print("Columns (header=0):")
        print(list(df.columns))
        
        # Try reading with header=1 just in case
        df2 = pd.read_excel(xl, sheet_name=sheet, header=1, nrows=5)
        print("Columns (header=1):")
        print(list(df2.columns))

except Exception as e:
    print(f"Error: {e}")
