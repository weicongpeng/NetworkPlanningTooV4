function outOfChina(lat: number, lng: number): boolean {
  return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
}

function transformLat(lng: number, lat: number): number {
  let ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
  ret += (20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(lat * Math.PI) + 40.0 * Math.sin(lat / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(lat / 12.0 * Math.PI) + 320 * Math.sin(lat * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(lng: number, lat: number): number {
  let ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
  ret += (20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(lng * Math.PI) + 40.0 * Math.sin(lng / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(lng / 12.0 * Math.PI) + 300.0 * Math.sin(lng / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

// WGS84 to GCJ02 (China GPS offset correction)
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) {
    return [lat, lng];
  }
  let dlat = transformLat(lng - 105.0, lat - 35.0);
  let dlng = transformLng(lng - 105.0, lat - 35.0);
  const radlat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radlat);
  magic = 1 - 0.00669342162296594323 * magic * magic;
  const sqrtmagic = Math.sqrt(magic);
  dlat = (dlat * 180.0) / ((6378245.0 * (1 - 0.00669342162296594323)) / (magic * sqrtmagic) * Math.PI);
  dlng = (dlng * 180.0) / (6378245.0 / sqrtmagic * Math.cos(radlat) * Math.PI);
  const mglat = lat + dlat;
  const mglng = lng + dlng;
  return [mglat, mglng];
}

// GCJ02 to WGS84 (approximate inverse using iteration)
export function gcj02ToWgs84(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) {
    return [lat, lng];
  }
  let wgsLat = lat;
  let wgsLng = lng;
  for (let i = 0; i < 5; i++) {
    const [gcjLat, gcjLng] = wgs84ToGcj02(wgsLat, wgsLng);
    const dLat = gcjLat - lat;
    const dLng = gcjLng - lng;
    wgsLat -= dLat;
    wgsLng -= dLng;
    if (Math.abs(dLat) < 1e-8 && Math.abs(dLng) < 1e-8) break;
  }
  return [wgsLat, wgsLng];
}
