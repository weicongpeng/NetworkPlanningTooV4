# coding: utf-8
import csv
import os,sys
import pandas as pd
from math import radians, cos, sin, asin, sqrt  
import time
import datetime

def check_license():
    try:
        with open("license.txt", "r") as f:
            license_data = f.read()
        
        expiration_date = None
        for line in license_data.split("\n"):
            if line.startswith("expiration_date="):
                # 分割键值对，并提取值部分
                key, value = line.split("=", 1)  # 使用 maxsplit=1 防止值中有多个等号
                expiration_date = datetime.datetime.strptime(value.strip(), "%Y-%m-%d").date()
                break  # 找到后退出循环
        
        if not expiration_date:
            print("授权文件无效：缺少到期时间")
            return False
        
        if datetime.date.today() > expiration_date:
            print("授权已过期")
            return False
        
        return True
    except FileNotFoundError:
        print("未找到授权文件")
        return False
    except ValueError as e:
        print(f"授权文件格式错误：{e}")
        return False

if not check_license():
    input("按 Enter 键退出...")
    sys.exit(1)

# 主程序逻辑
print("欢迎使用！")

def ptime():
    print(time.strftime('%Y-%m-%d %H:%M:%S',time.localtime(time.time())))
    
def haversine(lon1, lat1, lon2, lat2): # 经度1，纬度1，经度2，纬度2 （十进制度数）  
    """ 
    Calculate the great circle distance between two points  
    on the earth (specified in decimal degrees) 
    """  
    # 将十进制度数转化为弧度  
    lon1, lat1, lon2, lat2 = map(radians, [lon1, lat1, lon2, lat2])  
  
    # haversine公式  
    dlon = lon2 - lon1   
    dlat = lat2 - lat1   
    a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2  
    c = 2 * asin(sqrt(a))   
    r = 6371 # 地球平均半径，单位为公里  
    return c * r * 1000 

dd=os.path.realpath(sys.argv[0])
dd=os.path.dirname(dd)
os.chdir(dd)

ptime()
#0.01最大大概1-1.5km
#0.001最大大概100-150米
sep=float(input('输入相邻距离门限(0.01最大大概1-1.5km):'))
max_dis=float(input('输入最大相邻距离门限(输入比邻区对距离大的数，单位m):'))




outputfile="distance_temp.csv"
x1="wy.csv"#基准表
x2="gc.csv"#需要匹配的表
df1=pd.read_csv(x1,encoding="gbk",low_memory=False)
df2=pd.read_csv(x2,encoding="gbk",low_memory=False)
# 将经纬度列转为数值类型，避免字符串与浮点数比较报错
df1["LON"] = pd.to_numeric(df1["LON"], errors="coerce")
df1["LAT"] = pd.to_numeric(df1["LAT"], errors="coerce")
df2["LON"] = pd.to_numeric(df2["LON"], errors="coerce")
df2["LAT"] = pd.to_numeric(df2["LAT"], errors="coerce")
f1 = open(outputfile,"w")

gg1=[]
f1.write('CELL1,LON1,LAT1,CELL2,LON2,LAT2,Distance'+'\n')
for ix, row in df1.iterrows():
    gg=[] 
    CELL1=row['CELL']
    LON=row["LON"]
    LAT=row["LAT"]
    LON1=row["LON"]+sep
    LAT1=row["LAT"]+sep
    LON2=row["LON"]-sep
    LAT2=row["LAT"]-sep
    print(ix)
    
    gg=df2[ (df2["LON"]<=LON1) & (df2["LON"]>=LON2) & (df2["LAT"]<=LAT1) & (df2["LAT"]>=LAT2)]
    if gg.shape[0]!=0:   #获取矩阵 shape
        for ix1, row1 in gg.iterrows():
            dd=haversine(LON,LAT,row1['LON'],row1['LAT'])
            if dd<=max_dis:
                f1.write(str(CELL1)+","+str(LON)+","+str(LAT)+","+row1['CELL']+","+str(row1['LON'])+","+str(row1['LAT'])+","+str(dd)+"\n")
ptime()
