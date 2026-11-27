import React, { forwardRef, useImperativeHandle, useRef, useEffect, useCallback, useState } from 'react';
import { View, StyleSheet, Text, ActivityIndicator, TouchableOpacity } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { useMapStore } from '../../store/mapStore';
import { resetNavUiAutoHide, registerAmapLocationProvider } from '../../services/navigationService';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../../utils/coordinate';
import { sectorRenderer } from '../../services/sectorRenderer';

export interface MapViewRef {
  moveCamera: (lat: number, lng: number, zoom: number) => void;
  addRoute: (polyline: [number, number][]) => void;
  addAlternateRoute: (polyline: [number, number][]) => void;
  clearAlternateRoute: () => void;
  updateRemainingRoute: (fullPolyline: [number, number][], fromIndex: number) => void;
  clearRoute: () => void;
  showDestinationMarker: (lat: number, lng: number, name: string) => void;
  hideDestinationMarker: () => void;
  updateUserLocation: (lat: number, lng: number, heading: number) => void;
  clearUserLocation: () => void;
  fitRouteBounds: (polyline: [number, number][], totalDistance: number) => void;
  locateMe: (lat: number, lng: number, zoom: number) => void;
  startAutoFit: () => void;
  stopAutoFit: () => void;
  injectJavaScript: (script: string) => void;
  setNavContext: (remainingDistance: number, approachingTurn: boolean, mode: string, speedMps: number) => void;
  setNavRemainingDistance: (dist: number, approachingTurn: boolean) => void;
  setNavSpeed: (speedMps: number) => void;
  setNavMode: (mode: string) => void;
  clearAll: () => void;
  clearOverlays: () => void;
  /** 通过 WebView 内 AMap.Geolocation 做室内模糊定位，返回 WGS84 坐标 */
  requestAmapLocation: () => Promise<{ lat: number; lng: number; accuracy: number; source: string } | null>;
}
interface Props {
  initialCenter: [number, number];
  showSatellite: boolean;
  focusLocation?: { lat: number; lng: number } | null;
  onMapPress: (lat: number, lng: number) => void;
  onLongPress: (lat: number, lng: number) => void;
  onMarkerClick: (marker: any) => void;
  onMeasureFinish: () => void;
  onMeasureClear: () => void;
  onSectorOverlap: (sectors: any[], lat: number, lng: number) => void;
  onMapInteraction: () => void;
  onMapReady: () => void;
}

const AMAP_KEY = '9fa8b08372c3c764fd14d0bc74862ad1';

const _T0 = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>*{margin:0;padding:0;}html,body{width:100%;height:100%;overflow:hidden;overscroll-behavior:none;position:fixed}#map{width:100%;height:100%;overflow:hidden;touch-action:none}.amap-logo,.amap-copyright{display:none!important}</style><script id="amap-script" src="https://webapi.amap.com/maps?v=2.0&key=9fa8b08372c3c764fd14d0bc74862ad1&callback=onAMapLoaded&plugin=AMap.Geolocation" onerror="window._amapScriptError=true"></script></head><body><div id="map"></div><script>(function(){
var map=null;
/* Canvas 扇区渲染层(优先 AMap.CustomLayer 官方图层,降级为独立 DOM 叠加) */
var sctx=null;
var sectorCanvas=null;
var _sectorCustomLayer=null;
var _log=function(m){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'log',message:m}))};
/* batch log: collects logs and sends at once every 500ms to avoid flooding the bridge */
var _logBatch=[],_logTimer=null;
function _logLater(m){_logBatch.push(m);if(!_logTimer){_logTimer=setTimeout(function(){if(_logBatch.length>0){_log(_logBatch.join('|'));_logBatch=[]}_logTimer=null},500)}}
var _ready=false;
/* WGS84 to GCJ-02 */
function wgs84ToGcj02(lat,lng){
if(lng<72||lng>137||lat<0||lat>55)return[lat,lng];
var dlat=-100+2*(lng-105)+3*(lat-35)+0.2*(lat-35)*(lat-35)+0.1*(lng-105)*(lat-35)+0.2*Math.sqrt(Math.abs(lng-105));
dlat+=(20*Math.sin(6*(lng-105)*Math.PI)+20*Math.sin(2*(lng-105)*Math.PI))*2/3;
dlat+=(20*Math.sin((lat-35)*Math.PI)+40*Math.sin((lat-35)/3*Math.PI))*2/3;
dlat+=(160*Math.sin((lat-35)/12*Math.PI)+320*Math.sin((lat-35)*Math.PI/30))*2/3;
var dlng=300+(lng-105)+2*(lat-35)+0.1*(lng-105)*(lng-105)+0.1*(lng-105)*(lat-35)+0.1*Math.sqrt(Math.abs(lng-105));
dlng+=(20*Math.sin(6*(lng-105)*Math.PI)+20*Math.sin(2*(lng-105)*Math.PI))*2/3;
dlng+=(20*Math.sin((lng-105)*Math.PI)+40*Math.sin((lng-105)/3*Math.PI))*2/3;
dlng+=(150*Math.sin((lng-105)/12*Math.PI)+300*Math.sin((lng-105)/30*Math.PI))*2/3;
var rad=lat/180*Math.PI;var magic=1-0.00669342162296594323*Math.sin(rad)*Math.sin(rad);var sqrtm=Math.sqrt(magic);
dlat=dlat*180/(6378245*(1-0.00669342162296594323)/(magic*sqrtm)*Math.PI);
dlng=dlng*180/(6378245/sqrtm*Math.cos(rad)*Math.PI);
return[lat+dlat,lng+dlng]
}
/* Haversine distance in meters */
function _dist(lat1,lon1,lat2,lon2){
var R=6371000;var dLat=(lat2-lat1)*Math.PI/180;var dLon=(lon2-lon1)*Math.PI/180;
var a=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))
}
/* Sector overlay management */
var sectorOverlayMap={};
var selectedSectorId=null;
function makeSectorOverlay(sector){
/* 验证扇区数据有效性 */
if(!sector||sector.latitude==null||sector.longitude==null){
_log('Invalid sector data: '+JSON.stringify(sector));
return null;
}
var color=sector.networkType==='LTE'?'#4CAF50':'#2196F3';
var stroke=sector.networkType==='LTE'?'#2E7D32':'#1565C0';
var gcj=wgs84ToGcj02(sector.latitude,sector.longitude);
var lat=gcj[0],lng=gcj[1];
var ct=String(sector.cell_cover_type);
var isIndoor=sector.cell_cover_type===4||ct==='室分'||ct==='室内';
if(isIndoor){
return{overlay:new AMap.Circle({center:[lng,lat],radius:30,fillColor:color,fillOpacity:0.4,strokeColor:stroke,strokeWeight:1,bubble:true}),center:[lng,lat],radius:30,type:'circle',gcjLat:lat,gcjLng:lng,data:sector}
}
var az=(sector.azimuth==null?0:Number(sector.azimuth));
var bw=(sector.beamwidth==null?65:Number(sector.beamwidth));
var pts=[[lng,lat]];
var sa=90-az-bw/2,ea=90-az+bw/2;
for(var a=sa;a<=ea;a+=5){
var rad=a*Math.PI/180;var dx=60*Math.cos(rad);var dy=60*Math.sin(rad);
var dLng=dx/(111320*Math.cos(lat*Math.PI/180));var dLat=dy/110540;
pts.push([lng+dLng,lat+dLat])
}
pts.push([lng,lat]);
return{overlay:new AMap.Polygon({path:pts,fillColor:color,fillOpacity:0.35,strokeColor:stroke,strokeWeight:1,bubble:true}),path:pts,type:'poly',gcjLat:lat,gcjLng:lng,data:sector}
}
/* Ray-casting point-in-polygon test */
function _inPoly(lng,lat,poly){
var inside=false;
for(var i=0,j=poly.length-1;i<poly.length;j=i++){
var xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
if(yj===yi)continue;
if((yi>lat)!==(yj>lat)&&lng<(xj-xi)*(lat-yi)/(yj-yi)+xi)inside=!inside
}
return inside
}
/* Compass bearing from A to B (degrees, 0=North, clockwise) */
function _bearing(lat1,lng1,lat2,lng2){
var dLng=(lng2-lng1)*Math.PI/180;
var la1=lat1*Math.PI/180;var la2=lat2*Math.PI/180;
var y=Math.sin(dLng)*Math.cos(la2);
var x=Math.cos(la1)*Math.sin(la2)-Math.sin(la1)*Math.cos(la2)*Math.cos(dLng);
return(Math.atan2(y,x)*180/Math.PI+360)%360
}
/* Angular difference between two bearings (0-180) */
function _angleDiff(b1,b2){
var d=Math.abs(b1-b2);
return d>180?360-d:d
}
/* Distance-based nearest sector (fallback) */
function _nearestSector(lng,lat,maxDist){
var best=null,bestD=maxDist;
for(var id in sectorOverlayMap){
var e=sectorOverlayMap[id];
var d=_dist(e.gcjLat,e.gcjLng,lat,lng);
if(d<bestD){bestD=d;best=e}
}
return best
}
/* Hit-test: find sector at point
   Priority: 1) inside polygon  2) bearing within beam  3) near distance  4) nearest fallback
   增加手动导入场景下的命中容差(原 200m/500m 在密集扇区下太严) */
function _hitTest(lng,lat){
/* Canvas 模式:从 _viewportSectors 查找(sectorOverlayMap 为空时) */
if(window._viewportSectors&&window._viewportSectors.length>0){
var _hasOverlay=false;
for(var _k in sectorOverlayMap){_hasOverlay=true;break}
if(!_hasOverlay){
var best=null,bestDist=Infinity;
for(var i=0;i<window._viewportSectors.length;i++){
var s=window._viewportSectors[i];
/* 注入数据已预转 GCJ02(gcjLat/gcjLng);桥模式数据仅有 WGS84,需现场转换 */
var glat=s.gcjLat,glng=s.gcjLng;
if(glat==null||glng==null){
if(s.latitude==null||s.longitude==null)continue;
var gcj=wgs84ToGcj02(s.latitude,s.longitude);
glat=gcj[0];glng=gcj[1];
}
var d=_dist(glat,glng,lat,lng);
if(d<bestDist){bestDist=d;best=s}
}
if(best&&bestDist<=800){
_log('hitTest(canvas): id='+best.id+' d='+bestDist.toFixed(1)+'m');
return{data:best}
}
_log('hitTest(canvas): no hit, nearest d='+(best?bestDist.toFixed(1):'none'));
return null
}
}
/* 原有逻辑:从 sectorOverlayMap 查找(fallback / 降级模式) */
var bestInside=null,bestInsideDist=Infinity;
var bestBearing=null,bestBearingDist=Infinity,bestBearingDiff=Infinity;
var bestNear=null,bestNearDist=Infinity;
var checked=0;
for(var id in sectorOverlayMap){
var e=sectorOverlayMap[id];
var d=_dist(e.gcjLat,e.gcjLng,lat,lng);
checked++;
if(e.type==='circle'){
if(d<=e.radius&&d<bestInsideDist){bestInsideDist=d;bestInside=e}
else if(d<=150&&d<bestNearDist){bestNearDist=d;bestNear=e}
} else {
if(e.path&&_inPoly(lng,lat,e.path)){
if(d<bestInsideDist){bestInsideDist=d;bestInside=e}
_logLater('hit: id='+id+' INSIDE d='+d.toFixed(1)+'m');
} else {
var az=e.data.azimuth==null?0:Number(e.data.azimuth);
var bw=e.data.beamwidth==null?65:Number(e.data.beamwidth);
var bearing=_bearing(e.gcjLat,e.gcjLng,lat,lng);
var aDiff=_angleDiff(bearing,az);
if(aDiff<=bw/2&&d<=300){
if(aDiff<bestBearingDiff||(aDiff===bestBearingDiff&&d<bestBearingDist)){
bestBearingDiff=aDiff;bestBearingDist=d;bestBearing=e
}
_logLater('hit: id='+id+' bearing aDiff='+aDiff.toFixed(1)+' d='+d.toFixed(1)+'m');
} else if(d<=300&&d<bestNearDist){
bestNearDist=d;bestNear=e
}
}
}
}
_log('hitTest: checked='+checked+' inside='+(bestInside?bestInside.data.id:'no')+' bearing='+(bestBearing?bestBearing.data.id:'no')+' near='+(bestNear?bestNear.data.id:'no'));
var best=bestInside||bestBearing||bestNear;
if(!best){best=_nearestSector(lng,lat,800);if(best)_log('hitTest: fallback id='+best.data.id)}
return best
}
function selectSector(id){
if(selectedSectorId&&sectorOverlayMap[selectedSectorId]){
var e=sectorOverlayMap[selectedSectorId];var p=e.data;
var c=p.networkType==='LTE'?'#4CAF50':'#2196F3';var s=p.networkType==='LTE'?'#2E7D32':'#1565C0';
if(e.type==='circle')e.overlay.setOptions({fillColor:c,fillOpacity:0.4,strokeColor:s,strokeWeight:1,radius:30});
else e.overlay.setOptions({fillColor:c,fillOpacity:0.35,strokeColor:s,strokeWeight:1})
}
selectedSectorId=null;
if(id&&sectorOverlayMap[id]){
var e=sectorOverlayMap[id];
if(e.type==='circle')e.overlay.setOptions({fillColor:'#E53935',fillOpacity:0.6,strokeColor:'#B71C1C',strokeWeight:3,radius:50});
else e.overlay.setOptions({fillColor:'#E53935',fillOpacity:0.55,strokeColor:'#B71C1C',strokeWeight:3});
selectedSectorId=id
}
}
window.selectSector=function(id){selectSector(id)};
window.deselectSector=function(){selectSector(null)};
window.updateSectors=function(sectors){
_log('updateSectors:'+sectors.length);
if(!map||!window.sectorGroup)return;
window.sectorGroup.clearOverlays();
sectorOverlayMap={};
var overlays=[];
for(var k=0;k<sectors.length;k++){
var sector=sectors[k];
var info=makeSectorOverlay(sector);
if(!info)continue;
overlays.push(info.overlay);
sectorOverlayMap[sector.id]={overlay:info.overlay,data:sector,path:info.path,type:info.type,gcjLat:info.gcjLat,gcjLng:info.gcjLng,radius:info.radius}
}
if(overlays.length>0)window.sectorGroup.addOverlays(overlays);
if(selectedSectorId&&sectorOverlayMap[selectedSectorId]){
var e=sectorOverlayMap[selectedSectorId];
if(e.type==='circle')e.overlay.setOptions({fillColor:'#E53935',fillOpacity:0.6,strokeColor:'#B71C1C',strokeWeight:3,radius:50});
else e.overlay.setOptions({fillColor:'#E53935',fillOpacity:0.55,strokeColor:'#B71C1C',strokeWeight:3})
}
};
/* === 扇区 Canvas 重绘函数 ===
 * 独立 Canvas 叠加在 AMap 之上。
 * 性能要点:整帧仅 2 次投影标定米/像素比,之后每扇区只投影中心点 1 次,
 * 扇形弧边用注入时预计算的米偏移(s.pts)线性换算,投影调用从 14N 降至 N+2 */
function _redrawSectors(){
  if(!sctx||!sectorCanvas||!map)return;
  var dpr=window.devicePixelRatio||1;
  var w=window.innerWidth,h=window.innerHeight;
  if(sectorCanvas.width!==w*dpr||sectorCanvas.height!==h*dpr){
    sectorCanvas.width=w*dpr;sectorCanvas.height=h*dpr;
    sectorCanvas.style.width=w+'px';sectorCanvas.style.height=h+'px';
  }
  sctx.setTransform(dpr,0,0,dpr,0,0);
  sctx.clearRect(0,0,w,h);
  var sectors=window._viewportSectors||[];
  if(sectors.length===0)return;
  var selectedId=window._selectedSectorId||null;
  /* 局部线性标定:2 次投影求米/像素比(60m 扇区半径内误差亚像素级) */
  var _c=map.getCenter();
  var _refLat=_c.getLat(),_refLng=_c.getLng();
  var _p0=map.lngLatToContainer([_refLng,_refLat]);
  var _pE=map.lngLatToContainer([_refLng+0.001,_refLat]);
  var _pN=map.lngLatToContainer([_refLng,_refLat+0.001]);
  var _mPerDegLng=111320*Math.cos(_refLat*Math.PI/180);
  var mppX=(_pE.x-_p0.x)/(0.001*_mPerDegLng); /* 东向 米→像素 */
  var mppY=(_p0.y-_pN.y)/(0.001*110540);      /* 北向 米→像素(屏幕 y 向下) */
  if(!(mppX>0))mppX=1;
  if(!(mppY>0))mppY=1;
  for(var k=0;k<sectors.length;k++){
    var s=sectors[k];
    if(s.gcjLat==null||s.gcjLng==null)continue;
    var center=map.lngLatToContainer([s.gcjLng,s.gcjLat]);
    if(center.x<-100||center.x>w+100||center.y<-100||center.y>h+100)continue;
    var ct=String(s.cell_cover_type);
    var isIndoor=(s.indoor||s.cell_cover_type===4||ct==='室分'||ct==='室内');
    var isSelected=(selectedId===s.id);
    var fillColor=isSelected?'rgba(229,57,53,0.55)':(s.networkType==='LTE'?'rgba(76,175,80,0.35)':'rgba(33,150,243,0.35)');
    var strokeColor=isSelected?'#B71C1C':(s.networkType==='LTE'?'#2E7D32':'#1565C0');
    sctx.fillStyle=fillColor;sctx.strokeStyle=strokeColor;sctx.lineWidth=isSelected?3:1;
    sctx.beginPath();
    if(isIndoor){
      sctx.arc(center.x,center.y,30*mppX,0,2*Math.PI);
    }else if(s.pts){
      /* 快速路径:预计算弧边米偏移 [dx东,dy北] 直接线性换算 */
      sctx.moveTo(center.x,center.y);
      var pts=s.pts;
      for(var pi=0;pi<pts.length;pi++){
        sctx.lineTo(center.x+pts[pi][0]*mppX,center.y-pts[pi][1]*mppY);
      }
    }else{
      /* 兼容路径(桥模式数据无预计算顶点):逐顶点投影 */
      var az=(s.azimuth==null?0:Number(s.azimuth));
      var bw=(s.beamwidth==null?65:Number(s.beamwidth));
      var sa=(90-az-bw/2)*Math.PI/180;
      var ea=(90-az+bw/2)*Math.PI/180;
      sctx.moveTo(center.x,center.y);
      for(var a=sa;a<=ea;a+=Math.PI/36){
        var dx=60*Math.cos(a),dy=60*Math.sin(a);
        var dLng=dx/(111320*Math.cos(s.gcjLat*Math.PI/180));
        var dLat=dy/110540;
        var edge=map.lngLatToContainer([s.gcjLng+dLng,s.gcjLat+dLat]);
        sctx.lineTo(edge.x,edge.y);
      }
    }
    sctx.closePath();sctx.fill();sctx.stroke();
  }
}
/* === 本地网格空间索引(视窗查询不出 WebView,消除桥接往返) ===
 * 均匀网格,cell=0.01°(约 1km);扇区半径仅 60m,查询外扩 1 格即可覆盖跨格边界 */
var _sectorGrid=null;
var _useLocalIndex=false;
var GRID_CELL=0.01;
var MAX_LOCAL_VIEWPORT=8000;
function _buildGrid(list){
  var g={};
  for(var i=0;i<list.length;i++){
    var s=list[i];
    if(s.gcjLat==null||s.gcjLng==null)continue;
    var k=Math.floor(s.gcjLng/GRID_CELL)+'_'+Math.floor(s.gcjLat/GRID_CELL);
    var arr=g[k];
    if(!arr){arr=[];g[k]=arr}
    arr.push(s);
  }
  return g;
}
function _queryGrid(west,south,east,north){
  var res=[];
  var x0=Math.floor(west/GRID_CELL)-1,x1=Math.floor(east/GRID_CELL)+1;
  var y0=Math.floor(south/GRID_CELL)-1,y1=Math.floor(north/GRID_CELL)+1;
  for(var x=x0;x<=x1;x++){
    for(var y=y0;y<=y1;y++){
      var arr=_sectorGrid[x+'_'+y];
      if(!arr)continue;
      for(var i=0;i<arr.length;i++){
        var s=arr[i];
        if(s.gcjLng>=west&&s.gcjLng<=east&&s.gcjLat>=south&&s.gcjLat<=north)res.push(s);
      }
    }
  }
  /* 超上限按步长采样,防止一次性绘制过多图元 */
  if(res.length>MAX_LOCAL_VIEWPORT){
    var stride=res.length/MAX_LOCAL_VIEWPORT;
    var sampled=[];
    for(var j=0;j<MAX_LOCAL_VIEWPORT;j++)sampled.push(res[Math.floor(j*stride)]);
    return sampled;
  }
  return res;
}
/* 本地视窗刷新:moveend/zoomend 后直接本地查询+重绘,无桥接延迟 */
function _redrawLocal(){
  if(!map||!_sectorGrid)return;
  var b=map.getBounds();
  if(!b)return;
  var sw=b.getSouthWest(),ne=b.getNorthEast();
  if(!sw||!ne)return;
  window._viewportSectors=_queryGrid(sw.getLng(),sw.getLat(),ne.getLng(),ne.getLat());
  _redrawSectors();
}
/* 数据更新入口(Native 一次性全量注入):建网格索引并立即绘制当前视窗 */
window.setSectorData=function(payload){
  try{
    var list=(payload&&payload.sectors)||[];
    _useLocalIndex=!!(payload&&payload.useLocalIndex);
    _log('setSectorData: count='+list.length+' local='+_useLocalIndex);
    /* Canvas 不可用降级:沿用 AMap.Polygon 通道(updateSectors 走 WGS84) */
    if(!sctx){window.updateSectors(list);return}
    _sectorGrid=_useLocalIndex?_buildGrid(list):null;
    window._lastDrawCmd=null;
    if(_useLocalIndex){
      _redrawLocal();
    }else{
      /* 回退桥模式:向 Native 请求当前视窗渲染指令 */
      window._viewportSectors=[];
      _redrawSectors();
      window.scheduleRedraw();
    }
  }catch(e){_log('setSectorData ERROR: '+(e.message||e))}
};
/* === 手势跟手同步(rAF + CSS transform,手势期间 0 次逐扇区投影) ===
 * 手势开始时记录锚点(中心经纬度+其容器像素+zoom),rAF 每帧仅 1 次锚点投影,
 * 用 translate3d/scale 让 Canvas 与底图同帧合成;moveend 后清 transform 并完整重绘 */
var _gestureRaf=null;
var _gestureActive=false;
var _gestureAnchor=null;
var _gestureEndTimer=null;
function _gestureLoop(){
  if(!_gestureActive){_gestureRaf=null;return}
  try{
    if(map&&sectorCanvas&&_gestureAnchor){
      var pt=map.lngLatToContainer([_gestureAnchor.lng,_gestureAnchor.lat]);
      var dx=pt.x-_gestureAnchor.x,dy=pt.y-_gestureAnchor.y;
      var sc=Math.pow(2,map.getZoom()-_gestureAnchor.zoom);
      sectorCanvas.style.transformOrigin=_gestureAnchor.x+'px '+_gestureAnchor.y+'px';
      sectorCanvas.style.transform='translate3d('+dx+'px,'+dy+'px,0) scale('+sc+')';
    }
  }catch(e){}
  _gestureRaf=requestAnimationFrame(_gestureLoop);
}
function _gestureStart(){
  /* CustomLayer 模式下平移缩放由高德 pane 机制原生跟手,无需手动 transform 同步 */
  if(_sectorCustomLayer||_gestureActive||!map||!sectorCanvas||!sctx)return;
  if(_gestureEndTimer){clearTimeout(_gestureEndTimer);_gestureEndTimer=null}
  var c=map.getCenter();
  var pt=map.lngLatToContainer([c.getLng(),c.getLat()]);
  _gestureAnchor={lng:c.getLng(),lat:c.getLat(),zoom:map.getZoom(),x:pt.x,y:pt.y};
  _gestureActive=true;
  _gestureRaf=requestAnimationFrame(_gestureLoop);
}
/* 手势真正结束(moveend 触发):清 transform,本地/桥模式刷新视窗并完整重绘 */
function _gestureFinish(){
  if(_gestureEndTimer){clearTimeout(_gestureEndTimer);_gestureEndTimer=null}
  _gestureActive=false;
  if(_gestureRaf){cancelAnimationFrame(_gestureRaf);_gestureRaf=null}
  _gestureAnchor=null;
  if(sectorCanvas&&!_sectorCustomLayer)sectorCanvas.style.transform='';
  if(_useLocalIndex){_redrawLocal()}
  else{_redrawSectors();window.scheduleRedraw()}
}
/* dragend/zoomend 后地图可能还有惯性滚动,等 moveend;250ms 无 moveend 则兜底结束 */
function _gestureRequestEnd(){
  if(!_gestureActive)return;
  if(_gestureEndTimer)clearTimeout(_gestureEndTimer);
  _gestureEndTimer=setTimeout(_gestureFinish,250);
}
/* 数据更新入口:接收 native 下发的渲染指令,更新视窗扇区并重绘 */
window.drawSectors=function(cmd){
  if(!map)return;
  window._lastDrawCmd=cmd;
  window._viewportSectors=cmd.sectors||[];
  _redrawSectors();
};
/* 高亮选中扇区 */
window.highlightSector=function(id){
  window._selectedSectorId=id||null;
  _redrawSectors();
};
window.updateMarkers=function(markers){
_log('updateMarkers:'+markers.length);
if(!map||!window.markerGroup)return;
window.markerGroup.clearOverlays();
for(var i=0;i<markers.length;i++){
var m=markers[i];var gcj=wgs84ToGcj02(m.lat,m.lng);
/* 圆点改为 DOM Marker，避免被扇区 Canvas 覆盖 */
var dotEl=document.createElement('div');
dotEl.style.cssText='width:14px;height:14px;background:#E53935;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:pointer';
var dot=new AMap.Marker({position:[gcj[1],gcj[0]],content:dotEl,offset:new AMap.Pixel(-7,-7),zIndex:110,bubble:false,extData:m});
(function(d,md){d.on('click',function(){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'markerClick',marker:md}))})})(dot,m);
window.markerGroup.addOverlay(dot);
/* Add name label for each marker */
if(m.name){
var label=document.createElement('div');
label.style.cssText='background:rgba(229,57,53,0.9);color:#fff;padding:2px 6px;border-radius:8px;font-size:10px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.2);transform:translateX(-50%)';
label.textContent=m.name;
var labelMarker=new AMap.Marker({position:[gcj[1],gcj[0]],content:label,offset:new AMap.Pixel(0,-28),zIndex:111,bubble:true});
window.markerGroup.addOverlay(labelMarker)
}
}
};
window.updateMarkerMode=function(mode){
window._markerMode=!!mode;
_log('updateMarkerMode:'+mode)
};
window.updateMeasurePoints=function(points,mode,finished){
_log('updateMeasurePoints:'+points.length+' mode:'+mode);
window._measureMode=!!mode;
if(!map||!window.measureGroup)return;
window.measureGroup.clearOverlays();
/* Remove old measure panel marker */
if(window._measurePanelMarker){map.remove(window._measurePanelMarker);window._measurePanelMarker=null}
if(points.length===0)return;
var path=points.map(function(p){return[p.lng,p.lat]});
window.measureGroup.addOverlay(new AMap.Polyline({path:path,strokeColor:'#E53935',strokeWeight:3,strokeStyle:'dashed',strokeDash:[5,5],zIndex:300,strokeOpacity:1}));
for(var i=0;i<points.length;i++){
/* 测距圆点改为 DOM Marker，避免被扇区 Canvas 覆盖 */
var mDot=document.createElement('div');
mDot.style.cssText='width:14px;height:14px;background:#E53935;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.4);pointer-events:auto';
window.measureGroup.addOverlay(new AMap.Marker({position:[points[i].lng,points[i].lat],content:mDot,offset:new AMap.Pixel(-7,-7),zIndex:210,bubble:false}))
}
/* Add "起点" label at first point */
if(points.length>=1){
var first=points[0];
var startLabel=document.createElement('div');
startLabel.style.cssText='background:rgba(229,57,53,0.9);color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.2);transform:translateX(-50%)';
startLabel.textContent='起点';
var startMarker=new AMap.Marker({position:[first.lng,first.lat],content:startLabel,offset:new AMap.Pixel(0,-28),zIndex:211,bubble:true});
window.measureGroup.addOverlay(startMarker)
}
/* Add total distance panel at last point */
if(points.length>=2){
var last=points[points.length-1];
var totDist=0;for(var k=1;k<points.length;k++){totDist+=_dist(points[k-1].lat,points[k-1].lng,points[k].lat,points[k].lng)}
var distStr=totDist>=1000?(totDist/1000).toFixed(2)+'km':Math.round(totDist)+'m';
var panel=document.createElement('div');
panel.style.cssText='background:rgba(255,255,255,0.95);border-radius:8px;padding:6px 10px;font-size:12px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.25);transform:translateX(-50%)';
panel.onclick=function(e){e.stopPropagation()};
panel.innerHTML='<span style="color:#E53935;font-weight:bold;font-size:13px">'+distStr+'</span>'+
'<button onclick="event.stopPropagation();window.handleMeasureClear()" title="清除" aria-label="清除" style="width:22px;height:22px;padding:0;margin-left:6px;background:#E53935;border:none;border-radius:50%;cursor:pointer;vertical-align:middle;box-shadow:0 1px 3px rgba(0,0,0,0.3);display:inline-flex;align-items:center;justify-content:center">'+
'<svg width="10" height="10" viewBox="0 0 10 10" style="display:block"><path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg></button>';
window._measurePanelMarker=new AMap.Marker({position:[last.lng,last.lat],content:panel,offset:new AMap.Pixel(0,-45),zIndex:250,bubble:false});
map.add(window._measurePanelMarker)
}
};
window.updateSearchMarker=function(marker){
if(window._searchMarkerDot){map.remove(window._searchMarkerDot);window._searchMarkerDot=null}
if(window._searchMarker){map.remove(window._searchMarker);window._searchMarker=null}
if(!marker)return
/* 搜索标记中心点坐标：工参/用户输入为 WGS84，此处统一转换为 GCJ02 后再标记；isGcj=true（高德 POI）跳过转换 */
var src=marker;
var lat=src.lat,lng=src.lng;
if(!src.isGcj){var gcj=wgs84ToGcj02(src.lat,src.lng);lat=gcj[0];lng=gcj[1]}
/* 搜索圆点改为 DOM Marker，避免被扇区 Canvas 覆盖 */
var sDot=document.createElement('div');
sDot.style.cssText='width:14px;height:14px;background:#E53935;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.4)';
var dot=new AMap.Marker({position:[lng,lat],content:sDot,offset:new AMap.Pixel(-7,-7),zIndex:220,bubble:true});
map.add(dot);
window._searchMarkerDot=dot;
var label=document.createElement('div');
label.style.cssText='background:rgba(33,150,243,0.9);color:#fff;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.15);border:1.5px solid rgba(255,255,255,0.6);transform:translateX(-50%)';
label.innerHTML=marker.name||'搜索结果';
window._searchMarker=new AMap.Marker({position:[lng,lat],content:label,offset:new AMap.Pixel(0,-28),zIndex:221,bubble:true});
map.add(window._searchMarker)
};
window.setMapType=function(t){
if(!map)return;try{
var sl=window._satLayer,rn=window._roadLayer;
if(t===1){if(!sl){sl=new AMap.TileLayer.Satellite({zIndex:1});window._satLayer=sl}
if(!rn){rn=new AMap.TileLayer.RoadNet({zIndex:2});window._roadLayer=rn}map.add(sl);map.add(rn)}
else{if(sl)map.remove(sl);if(rn)map.remove(rn)}
}catch(e){_log('setMapType:'+(e.message||e))}};
window.moveCamera=function(lat,lng,zoom){if(map)map.setZoomAndCenter(zoom||16,[lng,lat])};
/* ===  === */
var _routePolyline=null;var _routePassedPolyline=null;var _routePolylinePoints=[];var _alternatePolyline=null;
var _routeGroup=null;
var _destinationMarker=null;var _destinationPin=null;
var _userLocationMarker=null;
var _autoFitEnabled=false;
var _userDragging=false;
var _lastNavSpeed=0;var _lastNavMode='';var _lastNavDistance=0;var _lastNavApproach=false;
var _currentNavZoom=16;var _targetNavZoom=16;
/* Dynamic navigation zoom — mimics mainstream nav apps */
function _calcNavZoom(){
  var speedKmh=_lastNavSpeed*3.6;
  var mode=_lastNavMode||'drive';
  var approaching=_lastNavApproach;
  var zoom=16;
  if(mode==='walk'||mode==='bicycling'){
    zoom=approaching?18:17;
  }else{
    if(speedKmh>80)zoom=approaching?16:14;
    else if(speedKmh>50)zoom=approaching?16:15;
    else if(speedKmh>20)zoom=approaching?17:16;
    else zoom=approaching?17:16;
    if(_lastNavDistance<200)zoom=Math.max(zoom,17);
    if(_lastNavDistance<50)zoom=18;
  }
  return Math.min(18,Math.max(12,zoom));
}
function _smoothNavZoom(){
  if(!_autoFitEnabled||_userDragging||!map)return;
  _targetNavZoom=_calcNavZoom();
  if(_currentNavZoom!==_targetNavZoom){
    var diff=_targetNavZoom-_currentNavZoom;
    if(Math.abs(diff)<0.3){_currentNavZoom=_targetNavZoom}
    else{_currentNavZoom+=diff*0.25}
    try{map.setZoom(Math.round(_currentNavZoom*10)/10)}catch(e){}
  }
}
function _mkRoutePolyline(pts,color,opacity){
  if(!pts||pts.length<2)return null;
  return new AMap.Polyline({path:pts,strokeColor:color||'#4CAF50',strokeWeight:10,strokeOpacity:opacity==null?0.9:opacity,lineJoin:'round',lineCap:'round',zIndex:300})
}
window.addRoute=function(p){
  if(!_routeGroup||!map)return;
  _routeGroup.clearOverlays();
  _routePolylinePoints=p||[];
  if(!p||p.length<2)return;
  _routePolyline=_mkRoutePolyline(p,'#4CAF50',0.9);
  if(_routePolyline)_routeGroup.addOverlay(_routePolyline);
  _log('addRoute: '+p.length+'')
};
window.addAlternateRoute=function(p){
  if(!_routeGroup||!map)return;
  if(!p||p.length<2)return;
  if(_alternatePolyline){_routeGroup.removeOverlay(_alternatePolyline);_alternatePolyline=null}
  _alternatePolyline=_mkRoutePolyline(p,'#90CAF9',0.6);
  if(_alternatePolyline)_routeGroup.addOverlay(_alternatePolyline);
  _log('addAlternateRoute: '+p.length+'')
};
window.clearAlternateRoute=function(){
  if(!_routeGroup)return;
  if(_alternatePolyline){_routeGroup.removeOverlay(_alternatePolyline);_alternatePolyline=null}
  _log('clearAlternateRoute')
};
window.updateRemainingRoute=function(p,fromIdx){
  if(!_routeGroup||!map)return;
  _routeGroup.clearOverlays();
  _routePolylinePoints=p||[];
  if(!p||p.length<2)return;
  var fromI=Math.max(0,Math.min(fromIdx||0,p.length-1));
  if(fromI>0&&fromI<p.length){
    _routePassedPolyline=_mkRoutePolyline(p.slice(0,fromI),'#9E9E9E',0.55);
    if(_routePassedPolyline)_routeGroup.addOverlay(_routePassedPolyline);
  }
  _routePolyline=_mkRoutePolyline(p.slice(fromI),'#4CAF50',0.95);
  if(_routePolyline)_routeGroup.addOverlay(_routePolyline);
  // 重新添加备选路线（clearOverlays 会清除它）
  if(_alternatePolyline)_routeGroup.addOverlay(_alternatePolyline);
  _log('updateRemainingRoute: total='+p.length+' from='+fromI+'');
};
window.clearRoute=function(){
  if(_routeGroup)_routeGroup.clearOverlays();
  _routePolyline=null;_routePassedPolyline=null;_routePolylinePoints=[];_alternatePolyline=null;
  _log('clearRoute')
};
window.showDestinationMarker=function(lat,lng,name){
  if(!map)return;
  /* 终点标记显示时移除搜索标记,避免同一位置出现重复文字标签 */
  if(window._searchMarkerDot){map.remove(window._searchMarkerDot);window._searchMarkerDot=null}
  if(window._searchMarker){map.remove(window._searchMarker);window._searchMarker=null}
  if(_destinationPin){map.remove(_destinationPin);_destinationPin=null}
  if(_destinationMarker){map.remove(_destinationMarker);_destinationMarker=null}
  /* 终点圆点改为 DOM Marker，避免被扇区 Canvas 覆盖 */
  var dPin=document.createElement('div');
  dPin.style.cssText='width:14px;height:14px;background:#2196F3;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.4)';
  _destinationPin=new AMap.Marker({position:[lng,lat],content:dPin,offset:new AMap.Pixel(-7,-7),zIndex:148});
  map.add(_destinationPin);
  var label=document.createElement('div');
  label.style.cssText='background:#2196F3;color:#fff;padding:4px 10px;border-radius:14px;font-size:12px;font-weight:600;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.3);border:1.5px solid #fff;transform:translateX(-50%);position:relative;';
  label.innerHTML=(name||'')+'<div style="position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid #2196F3"></div>';
  _destinationMarker=new AMap.Marker({position:[lng,lat],content:label,offset:new AMap.Pixel(0,-38),zIndex:150});
  map.add(_destinationMarker);
  _log('showDestinationMarker: '+name)
};
window.hideDestinationMarker=function(){
  if(!map)return;
  if(_destinationPin){map.remove(_destinationPin);_destinationPin=null}
  if(_destinationMarker){map.remove(_destinationMarker);_destinationMarker=null}
};
window.updateUserLocation=function(lat,lng,heading){
  if(!map)return;
  if(_userLocationMarker){map.remove(_userLocationMarker);_userLocationMarker=null}
  if(isNaN(lat)||isNaN(lng)){_log('updateUserLocation skip: invalid lat/lng');return}
  var h=isNaN(heading)?0:heading;
  var arrow=document.createElement('div');
  arrow.style.cssText='width:22px;height:22px;background:#34C759;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.4);position:relative;transform:rotate('+h+'deg)';
  arrow.innerHTML='<div style="position:absolute;top:0px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:16px solid #fff"></div>';
  _userLocationMarker=new AMap.Marker({position:[lng,lat],content:arrow,offset:new AMap.Pixel(-11,-11),zIndex:200});
  map.add(_userLocationMarker);
  if(_autoFitEnabled&&!_userDragging)try{map.setCenter([lng,lat])}catch(e){_log('setCenter err:'+(e.message||e))}
  _smoothNavZoom();
  _log('updateUserLocation: '+lat.toFixed(5)+','+lng.toFixed(5)+' h='+h.toFixed(0))
};
window.showMyLocationDot=function(lat,lng){
  if(!map)return;
  if(isNaN(lat)||isNaN(lng)){_log('showMyLocationDot skip: invalid lat/lng');return}
  if(_userLocationMarker){map.remove(_userLocationMarker);_userLocationMarker=null}
  var dot=document.createElement('div');
  dot.style.cssText='width:22px;height:22px;background:#34C759;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.4);position:relative;';
  dot.innerHTML='<div style="position:absolute;top:0px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:16px solid #fff"></div>';
  _userLocationMarker=new AMap.Marker({position:[lng,lat],content:dot,offset:new AMap.Pixel(-11,-11),zIndex:200});
  map.add(_userLocationMarker);
  _log('showMyLocationDot: '+lat.toFixed(5)+','+lng.toFixed(5))
};
window.clearUserLocation=function(){
  if(!map)return;
  if(_userLocationMarker){map.remove(_userLocationMarker);_userLocationMarker=null}
};
window.fitRouteBounds=function(p){
  if(!map||!p||p.length<2)return;
  try{
    var minLng=p[0][0],maxLng=p[0][0],minLat=p[0][1],maxLat=p[0][1];
    for(var i=1;i<p.length;i++){
      if(isNaN(p[i][0])||isNaN(p[i][1]))continue;
      if(p[i][0]<minLng)minLng=p[i][0];if(p[i][0]>maxLng)maxLng=p[i][0];
      if(p[i][1]<minLat)minLat=p[i][1];if(p[i][1]>maxLat)maxLat=p[i][1];
    }
    var cLat=(minLat+maxLat)/2,cLng=(minLng+maxLng)/2;
    var latSpan=maxLat-minLat,lngSpan=maxLng-minLng;
    var zoom=14;
    if(latSpan<0.005&&lngSpan<0.005)zoom=17;
    else if(latSpan<0.01&&lngSpan<0.01)zoom=16;
    else if(latSpan<0.03&&lngSpan<0.03)zoom=15;
    else if(latSpan<0.08&&lngSpan<0.08)zoom=14;
    else if(latSpan<0.2&&lngSpan<0.2)zoom=13;
    else if(latSpan<0.5&&lngSpan<0.5)zoom=12;
    else zoom=11;
    map.setZoomAndCenter(zoom,[cLng,cLat]);
  }catch(e){_log('fitRouteBounds err:'+(e.message||e))}
  _log('fitRouteBounds: '+p.length+'')
};
window.enableAutoFit=function(){
  // 已经启用则不重置 _currentNavZoom/清拖拽标志,避免每秒强制覆盖用户手动缩放/拖动
  if(_autoFitEnabled)return;
  _autoFitEnabled=true;_userDragging=false;
  _currentNavZoom=map?map.getZoom():16;_targetNavZoom=_currentNavZoom;
  _log('enableAutoFit')
};
window.disableAutoFit=function(){_autoFitEnabled=false};
window.resetLocationUpdates=function(){_autoFitEnabled=false};
window.setNavContext=function(d,a,m,s){
  _lastNavDistance=d||0;_lastNavApproach=!!a;_lastNavMode=m||'';_lastNavSpeed=s||0;
  _smoothNavZoom();
};
window.setNavRemainingDistance=function(d,a){_lastNavDistance=d||0;_lastNavApproach=!!a};
window.setNavSpeed=function(s){_lastNavSpeed=s||0};
window.setNavMode=function(m){_lastNavMode=m||''};
window.clearAll=function(){
_log('clearAll')
if(window._searchMarkerDot){map.remove(window._searchMarkerDot);window._searchMarkerDot=null}
if(window._searchMarker){map.remove(window._searchMarker);window._searchMarker=null}
if(window._measurePanelMarker){map.remove(window._measurePanelMarker);window._measurePanelMarker=null}
if(window._satLayer){map.remove(window._satLayer);window._satLayer=null}
if(window._roadLayer){map.remove(window._roadLayer);window._roadLayer=null}
if(window.sectorGroup){window.sectorGroup.clearOverlays()}
if(window.markerGroup){window.markerGroup.clearOverlays()}
if(window.measureGroup){window.measureGroup.clearOverlays()}
if(_routeGroup){_routeGroup.clearOverlays()}
if(_destinationPin){map.remove(_destinationPin);_destinationPin=null}
if(_destinationMarker){map.remove(_destinationMarker);_destinationMarker=null}
if(_userLocationMarker){map.remove(_userLocationMarker);_userLocationMarker=null}
_routePolyline=null;_routePassedPolyline=null;_routePolylinePoints=[];
window.deselectSector();
if(sctx&&sectorCanvas){sctx.clearRect(0,0,sectorCanvas.width,sectorCanvas.height);window._lastDrawCmd=null;window._viewportSectors=[];window._selectedSectorId=null}
};
/* Clear only overlays (measure/marker/nav/search), keep sector layers */
window.clearOverlays=function(){
_log('clearOverlays')
if(window._searchMarkerDot){map.remove(window._searchMarkerDot);window._searchMarkerDot=null}
if(window._searchMarker){map.remove(window._searchMarker);window._searchMarker=null}
if(window._measurePanelMarker){map.remove(window._measurePanelMarker);window._measurePanelMarker=null}
if(window.markerGroup){window.markerGroup.clearOverlays()}
if(window.measureGroup){window.measureGroup.clearOverlays()}
if(_routeGroup){_routeGroup.clearOverlays()}
if(_destinationPin){map.remove(_destinationPin);_destinationPin=null}
if(_destinationMarker){map.remove(_destinationMarker);_destinationMarker=null}
if(_userLocationMarker){map.remove(_userLocationMarker);_userLocationMarker=null}
_routePolyline=null;_routePassedPolyline=null;_routePolylinePoints=[];
window.deselectSector();
};
/* === 高德 Web 模糊定位(室内无 GPS 时兜底) ===
 * WebView geolocationEnabled=true 时 AMap.Geolocation 走系统融合定位(WiFi/基站),
 * 不依赖 GMS;失败时 getCityInfo 返回 IP 城市级中心。坐标为 GCJ-02,RN 侧负责转 WGS84 */
var _amapGeo=null;
window.requestAmapLocation=function(reqId){
  var reply=function(ok,lat,lng,acc,src){
    if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'amapLocation',reqId:reqId,success:ok,lat:lat,lng:lng,accuracy:acc,source:src}));
  };
  try{
    if(typeof AMap==='undefined'||!AMap.Geolocation){reply(false,null,null,null,null);return}
    if(!_amapGeo)_amapGeo=new AMap.Geolocation({enableHighAccuracy:false,timeout:8000,needAddress:false});
    _amapGeo.getCurrentPosition(function(status,result){
      if(status==='complete'&&result&&result.position){
        reply(true,result.position.lat,result.position.lng,result.accuracy||2000,'amap-web');
      }else{
        try{
          _amapGeo.getCityInfo(function(s2,r2){
            if(s2==='complete'&&r2&&r2.center&&r2.center.length===2)reply(true,r2.center[1],r2.center[0],5000,'ip');
            else reply(false,null,null,null,null);
          });
        }catch(e2){reply(false,null,null,null,null)}
      }
    });
  }catch(e){_log('requestAmapLocation ERR:'+(e.message||e));reply(false,null,null,null,null)}
};
window.handleMeasureFinish=function(){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'measureFinish'}))};
window.handleMeasureClear=function(){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'measureClear'}))};
/* Init */
function initMap(){
try{
_log('Init map');
map=new AMap.Map('map',{zoom:12,center:[114.7,23.74],viewMode:'2D',resizeEnable:true});
window.map=map;
map.on('complete',function(){_log('Tiles loaded')});
/* === 扇区渲染层(优先 AMap.CustomLayer) ===
 * 严格按"底图→扇区→矢量覆盖物→DOM Marker"顺序添加图层:
 * 1) 扇区 CustomLayer zIndex=2:仅高于底图瓦片(zIndex≈0),低于矢量覆盖物默认层;
 * 2) 之后再添加 sectorGroup/markerGroup/measureGroup/_routeGroup,
 *    并通过 setzIndex(200) 把 OverlayGroup 整体抬到扇区层之上,
 *    保证 Polyline/Polygon 等矢量覆盖物不会被扇区 Canvas 盖住;
 * 3) 圆点类(打点/测距/搜索/终点)均使用 DOM 版 AMap.Marker 渲染,
 *    位于独立的 Marker DOM 容器内,永远在 Canvas 图层最顶层,不参与 Canvas 层叠。
 * CustomLayer 不可用时降级为手动 DOM Canvas 叠加(z-index:1) */
sectorCanvas=document.createElement('canvas');
sctx=sectorCanvas.getContext('2d');
if(sctx){
  try{
    if(!AMap.CustomLayer)throw new Error('AMap.CustomLayer unavailable');
    _sectorCustomLayer=new AMap.CustomLayer(sectorCanvas,{zIndex:2,zooms:[3,20],alwaysRender:false});
    _sectorCustomLayer.render=function(){_redrawSectors()};
    map.add(_sectorCustomLayer);
    _log('CustomLayer sector layer ready');
  }catch(e){
    _log('CustomLayer fallback to manual canvas: '+(e.message||e));
    _sectorCustomLayer=null;
    sectorCanvas.style.cssText='position:absolute;top:0;left:0;pointer-events:none;z-index:1;will-change:transform';
    var mapDiv=document.getElementById('map');
    mapDiv.appendChild(sectorCanvas);
  }
}
/* OverlayGroup 在扇区层之后添加,确保矢量覆盖物渲染在扇区之上 */
window.sectorGroup=new AMap.OverlayGroup();
window.markerGroup=new AMap.OverlayGroup();
window.measureGroup=new AMap.OverlayGroup();
_routeGroup=new AMap.OverlayGroup();
try{
  if(window.sectorGroup.setzIndex)window.sectorGroup.setzIndex(200);
  if(window.markerGroup.setzIndex)window.markerGroup.setzIndex(200);
  if(window.measureGroup.setzIndex)window.measureGroup.setzIndex(200);
  if(_routeGroup.setzIndex)_routeGroup.setzIndex(200);
}catch(_e){}
window.sectorGroup.setMap(map);
window.markerGroup.setMap(map);
window.measureGroup.setMap(map);
_routeGroup.setMap(map);
window._lastDrawCmd=null;
window._viewportSectors=[];
window._selectedSectorId=null;

if(!sctx){
  _log('Canvas not supported, fallback to AMap.Polygon');
  window.drawSectors=function(cmd){
    if(cmd.sectors&&cmd.sectors.length>0)window.updateSectors(cmd.sectors);
  };
  window.highlightSector=function(id){
    if(id)window.selectSector(id);else window.deselectSector();
  };
}
/* Map click with hit-testing for sectors (300ms debounce to prevent double-firing on mobile) */
var _lastClickTime=0;
map.on('click',function(e){
var now=Date.now();
if(now-_lastClickTime<300){_log('click: debounce skip, dt='+(now-_lastClickTime)+'ms');return}
_lastClickTime=now;
var lat=e.lnglat.getLat(),lng=e.lnglat.getLng();
var cnt=0;for(var k in sectorOverlayMap)cnt++;
_log('click: sectors='+cnt+' pt='+lat.toFixed(6)+','+lng.toFixed(6));
/* In measure/marker mode, always send mapClick (not sectorClick) */
if(window._measureMode||window._markerMode){
_log('click: measure/marker mode, sending mapClick');
if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapClick',lat:lat,lng:lng}));
return
}
var hit=_hitTest(lng,lat);
if(hit){_log('sectorHit: id='+hit.data.id+' name='+(hit.data.name||''));selectSector(hit.data.id);if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'sectorClick',sector:hit.data}));return}
_log('click: no sector hit, sending mapClick');
if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapClick',lat:lat,lng:lng}))
});
map.on('longpress',function(e){
/* In measure/marker mode, suppress longpress to avoid conflicts */
if(window._measureMode||window._markerMode)return;
if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapLongPress',lat:e.lnglat.getLat(),lng:e.lnglat.getLng()}))
});
/* User drag detection: pause auto-fit while dragging, resume after 5s
 * 注意：必须用 dragstart/dragend 而非 movestart/moveend。
 * movestart 会被程序触发的 setCenter/setZoom 引发，导致 updateUserLocation
 * 每次定位更新都发送 mapInteraction → resetNavUiAutoHide → TabBar 反复隐藏/出现。
 * dragstart 只在用户手动拖拽时触发，程序 setCenter 不会触发。
 */
var _dragResumeTimer=null;
map.on('dragstart',function(){
if(_autoFitEnabled){_userDragging=true;if(_dragResumeTimer)clearTimeout(_dragResumeTimer)}
if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapInteraction'}))
});
map.on('dragend',function(){if(_autoFitEnabled){if(_dragResumeTimer)clearTimeout(_dragResumeTimer);_dragResumeTimer=setTimeout(function(){_userDragging=false},5000)}});
/* === Canvas 重绘调度(30ms 节流,减少跟手延迟)=== */
var _redrawTimer=null;
window.scheduleRedraw=function(){
  if(_redrawTimer)return;
  _redrawTimer=setTimeout(function(){
    _redrawTimer=null;
    try{
    if(!map)return;
    var zoom=map.getZoom();
    var b=map.getBounds();
    if(!b)return;
    var sw=b.getSouthWest(),ne=b.getNorthEast();
    if(!sw||!ne)return;
    if(window.ReactNativeWebView){
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type:'viewportChanged',
        zoom:zoom,
        bounds:{west:sw.getLng(),south:sw.getLat(),east:ne.getLng(),north:ne.getLat()}
      }));
    }
    }catch(e){_log('scheduleRedraw ERROR: '+(e.message||e))}
  },30);
};
/* === 拖动/缩放同步策略(transform 跟手方案) ===
 * 手势中: rAF 循环只对锚点做 1 次投影,用 CSS transform 平移/缩放 Canvas,
 *         与底图同帧 GPU 合成,不随 AMap 事件粒度受限(解决 zoom 事件稀疏);
 * 手势结束(moveend): 清 transform,本地网格查询视窗(或桥模式)并完整重绘 */
map.on('dragstart',_gestureStart);
map.on('zoomstart',_gestureStart);
map.on('movestart',_gestureStart);
map.on('moveend',function(){
  if(_gestureActive||_gestureEndTimer){_gestureFinish()}
  else if(_useLocalIndex){_redrawLocal()}
  else{window.scheduleRedraw()}
});
map.on('dragend',_gestureRequestEnd);
map.on('zoomend',_gestureRequestEnd);
_ready=true;
if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapReady'}));_log('mapReady sent')}
}catch(e){_log('Init error:'+(e.message||e));if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapError',message:e.message||String(e)}))}
}
/* Guard */
var _initDone=false;
function _sendMapError(msg){
  _log('mapError: '+msg);
  if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapError',message:msg}))
}
window.onAMapLoaded=function(){
  if(window._amapScriptError){_sendMapError('高德地图脚本加载失败');return}
  if(!_initDone){_initDone=true;initMap()}
};
setTimeout(function(){
  if(_initDone)return;
  if(window._amapScriptError){_sendMapError('高德地图脚本加载失败');return}
  if(typeof AMap==='undefined'){_sendMapError('高德地图加载超时');return}
  _initDone=true;initMap();
},2000);
setTimeout(function(){if(!_initDone){_sendMapError('地图初始化超时(15s)')}},15000);
_log('Started');
window.onerror=function(m){_log('ERR:'+m)};
})();</script></body></html>`;
const HTML_TEMPLATE = _T0;

const _MapView = (forwardRef as any)(function MapView(props: any, ref: any) {
  const webViewRef = useRef<WebView>(null);
  const [mapReady, setMapReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [webViewKey, setWebViewKey] = useState(0);
  const injectJS = useCallback((code: string) => { webViewRef.current?.injectJavaScript(code); }, []);

  // Use refs for callback props to avoid stale closure in handleMessage
  const propsRef = useRef(props);
  propsRef.current = props;

  // 高德 Web 模糊定位请求注册表（reqId -> resolver）
  const amapLocReqId = useRef(0);
  const amapLocPending = useRef<Map<number, (v: { lat: number; lng: number; accuracy: number; source: string } | null) => void>>(new Map());

  // 通过 WebView 内 AMap.Geolocation 做室内模糊定位，返回 WGS84
  const requestAmapLocationAsync = useCallback(() => new Promise<{ lat: number; lng: number; accuracy: number; source: string } | null>((resolve) => {
    if (!mapReady || !webViewRef.current) { resolve(null); return; }
    const id = ++amapLocReqId.current;
    amapLocPending.current.set(id, resolve);
    setTimeout(() => {
      const r = amapLocPending.current.get(id);
      if (r) { amapLocPending.current.delete(id); r(null); }
    }, 12000);
    injectJS(`window.requestAmapLocation(${id});`);
  }), [mapReady, injectJS]);

  // 注册给导航服务，作为室内无 GPS 时的模糊定位兜底通道
  useEffect(() => {
    registerAmapLocationProvider(requestAmapLocationAsync);
    return () => registerAmapLocationProvider(null);
  }, [requestAmapLocationAsync]);

  // Store data
  const lteSectors = useMapStore((s: any) => s.lteSectors);
  const nrSectors = useMapStore((s: any) => s.nrSectors);
  const markers = useMapStore((s: any) => s.markers);
  const measurePoints = useMapStore((s: any) => s.measurePoints);
  const measureMode = useMapStore((s: any) => s.measureMode);
  const measureFinished = useMapStore((s: any) => s.measureFinished);
  const searchMarker = useMapStore((s: any) => s.searchMarker);
  const layers = useMapStore((s: any) => s.layers);
  const selectedSector = useMapStore((s: any) => s.selectedSector);
  const setSelectedSector = useMapStore((s: any) => s.setSelectedSector);
  const markerMode = useMapStore((s: any) => s.markerMode);

  // 一次性全量注入扇区数据(字段裁剪+GCJ02 预转+顶点预计算),
  // WebView 建本地网格索引后视窗查询/重绘不再走桥;超阈值时 useLocalIndex=false 自动回退桥模式
  const injectAllSectors = useCallback(() => {
    const state = useMapStore.getState();
    const visibleLte = state.layers?.lte?.visible ? state.lteSectors : [];
    const visibleNr = state.layers?.nr?.visible ? state.nrSectors : [];
    sectorRenderer.updateSectors(visibleLte, visibleNr);
    const payload = sectorRenderer.buildInjectionPayload();
    injectJS(`window.setSectorData(${JSON.stringify(payload)});`);
  }, [injectJS]);

  // Sync all data to WebView — only used for initial sync on mapReady
  // Reads from store directly to avoid stale closure issues
  const syncAllData = useCallback(() => {
    if (!mapReady) return;
    const state = useMapStore.getState();
    injectAllSectors();
    injectJS(`window.updateMarkers(${JSON.stringify(state.markers || [])});`);
    injectJS(`window.updateMeasurePoints(${JSON.stringify(state.measurePoints || [])}, ${!!state.measureMode}, ${!!state.measureFinished});`);
    injectJS(`window.updateMarkerMode(${!!state.markerMode});`);
    if (state.searchMarker) injectJS(`window.updateSearchMarker(${JSON.stringify(state.searchMarker)});`);
    else injectJS('window.updateSearchMarker(null);');
  }, [mapReady, injectJS, injectAllSectors]);

  // Handle message from WebView
  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      const currentProps = propsRef.current;
      switch (data.type) {
        case 'mapReady':
          setMapReady(true);
          setLoadError(null);
          currentProps.onMapReady?.();
          break;
        case 'mapError':
          console.error('[MapView] Web map error:', data.message);
          setLoadError('地图脚本加载失败，请检查网络后重试');
          break;
        case 'mapTimeout':
          console.error('[MapView] Web map load timeout');
          setLoadError('地图加载超时，请检查网络后重试');
          break;
        case 'viewportChanged': {
          if (data.zoom == null || !data.bounds) break;
          const cmd = sectorRenderer.computeRender(data.zoom, data.bounds);
          injectJS(`window.drawSectors(${JSON.stringify(cmd)});`);
          if (selectedSector) {
            injectJS(`window.highlightSector(${JSON.stringify(selectedSector.id)});`);
          }
          break;
        }
        case 'mapClick':
          console.log('[MapView] mapClick:', data.lat, data.lng);
          currentProps.onMapPress?.(data.lat, data.lng);
          resetNavUiAutoHide();
          break;
        case 'mapLongPress':
          currentProps.onLongPress?.(data.lat, data.lng);
          resetNavUiAutoHide();
          break;
        case 'markerClick':
          if (data.marker) currentProps.onMarkerClick?.(data.marker);
          resetNavUiAutoHide();
          break;
        case 'sectorClick': {
          console.log('[MapView] sectorClick:', data.sector?.id);
          // 注入数据是字段裁剪版(仅渲染+hitTest 所需),详情面板需要完整字段,
          // 按 id 从 store 查完整扇区;查不到(桥模式已带完整字段)则直接用回传数据
          const clickedId = data.sector?.id;
          const state = useMapStore.getState();
          const full = clickedId
            ? [...(state.lteSectors || []), ...(state.nrSectors || [])].find((s: any) => s.id === clickedId)
            : null;
          setSelectedSector?.(full || data.sector);
          resetNavUiAutoHide();
          break;
        }
        case 'amapLocation': {
          const resolver = amapLocPending.current.get(data.reqId);
          if (resolver) {
            amapLocPending.current.delete(data.reqId);
            if (data.success && typeof data.lat === 'number' && typeof data.lng === 'number') {
              // 高德返回 GCJ-02，转为 WGS84 供导航服务统一使用
              const wgs = gcj02ToWgs84(data.lat, data.lng);
              resolver({ lat: wgs[0], lng: wgs[1], accuracy: data.accuracy || 5000, source: data.source || 'amap-web' });
            } else {
              resolver(null);
            }
          }
          break;
        }
        case 'log':
          console.log('[MapView Web]', data.message);
          if (data.message && data.message.indexOf('GLOBAL_ERROR') >= 0) {
            console.error('[MapView Web ERROR]', data.message);
          }
          break;
        case 'renderError':
          console.error('[MapView Render ERROR]', data.message);
          break;
        case 'measureClear': currentProps.onMeasureClear?.(); break;
        case 'measureFinish': currentProps.onMeasureFinish?.(); break;
        case 'mapInteraction': currentProps.onMapInteraction?.(); resetNavUiAutoHide(); break;
      }
    } catch(err) { console.error('[MapView] message error:', err); }
  }, [setSelectedSector, selectedSector]);

  const handleError = useCallback((syntheticEvent: any) => {
    console.error('[MapView] WebView onError:', syntheticEvent?.nativeEvent);
    setLoadError('WebView 加载失败，请重试');
  }, []);

  const handleHttpError = useCallback((syntheticEvent: any) => {
    console.error('[MapView] WebView onHttpError:', syntheticEvent?.nativeEvent);
  }, []);

  const handleLoadEnd = useCallback(() => {
    console.log('[MapView] WebView loadEnd');
  }, []);

  const retryLoad = useCallback(() => {
    setMapReady(false);
    setLoadError(null);
    setWebViewKey(k => k + 1);
  }, []);

  // Sync all data when map becomes ready
  useEffect(() => {
    if (mapReady) syncAllData();
  }, [mapReady, syncAllData]);

  // Re-sync sectors when data changes (skip initial mapReady to avoid double call with syncAllData)
  const sectorSyncedRef = useRef(false);
  useEffect(() => {
    if (!mapReady) return;
    if (!sectorSyncedRef.current) {
      sectorSyncedRef.current = true;
      return; // skip first run — handled by syncAllData
    }
    injectAllSectors();
  }, [lteSectors, nrSectors, layers?.lte?.visible, layers?.nr?.visible, mapReady, injectAllSectors]);

  // 选中扇区变化时触发 Canvas 高亮重绘
  useEffect(() => {
    if (!mapReady) return;
    if (selectedSector) {
      injectJS(`window.highlightSector(${JSON.stringify(selectedSector.id)});`);
    } else {
      injectJS(`window.highlightSector(null);`);
    }
  }, [selectedSector, mapReady]);

  // Re-sync markers
  useEffect(() => {
    if (!mapReady) return;
    injectJS(`window.updateMarkers(${JSON.stringify(markers || [])});`);
  }, [markers, mapReady]);

  // Re-sync measure points
  useEffect(() => {
    if (!mapReady) return;
    injectJS(`window.updateMeasurePoints(${JSON.stringify(measurePoints || [])}, ${!!measureMode}, ${!!measureFinished});`);
  }, [measurePoints, measureMode, measureFinished, mapReady]);

  // Re-sync marker mode
  useEffect(() => {
    if (!mapReady) return;
    injectJS(`window.updateMarkerMode(${!!markerMode});`);
  }, [markerMode, mapReady]);

  // Re-sync search marker
  useEffect(() => {
    if (!mapReady) return;
    if (searchMarker) injectJS(`window.updateSearchMarker(${JSON.stringify(searchMarker)});`);
    else injectJS('window.updateSearchMarker(null);');
  }, [searchMarker, mapReady]);

  // Focus location
  useEffect(() => {
    if (!mapReady || !props.focusLocation) return;
    injectJS(`window.moveCamera(${props.focusLocation.lat}, ${props.focusLocation.lng}, 16);`);
  }, [props.focusLocation, mapReady]);

  // Sync satellite layer
  useEffect(() => {
    if (!mapReady) return;
    injectJS(`window.setMapType(${props.showSatellite ? 1 : 0});`);
  }, [props.showSatellite, mapReady]);

  // useImperativeHandle
  useImperativeHandle(ref, () => ({
    moveCamera: (lat: number, lng: number, zoom: number) => injectJS(`window.moveCamera(${lat}, ${lng}, ${zoom || 16});`),
    addRoute: (polyline: [number, number][]) => injectJS(`window.addRoute(${JSON.stringify(polyline)});`),
    addAlternateRoute: (polyline: [number, number][]) => injectJS(`window.addAlternateRoute(${JSON.stringify(polyline)});`),
    clearAlternateRoute: () => injectJS('window.clearAlternateRoute();'),
    updateRemainingRoute: (fullPolyline: [number, number][], fromIndex: number) => injectJS(`window.updateRemainingRoute(${JSON.stringify(fullPolyline)}, ${fromIndex});`),
    clearRoute: () => injectJS('window.clearRoute();'),
    showDestinationMarker: (lat: number, lng: number, name: string) => injectJS(`window.showDestinationMarker(${lat}, ${lng}, ${JSON.stringify(name)});`),
    hideDestinationMarker: () => injectJS('window.hideDestinationMarker();'),
    updateUserLocation: (lat: number, lng: number, heading: number) => injectJS(`window.updateUserLocation(${lat}, ${lng}, ${heading || 0});`),
    clearUserLocation: () => injectJS('window.clearUserLocation();'),
    fitRouteBounds: (polyline: [number, number][], totalDistance: number) => injectJS(`window.fitRouteBounds(${JSON.stringify(polyline)}, ${totalDistance || 0});`),
    locateMe: (lat: number, lng: number, zoom: number) => {
      injectJS('window.resetLocationUpdates();');
      injectJS(`window.moveCamera(${lat}, ${lng}, ${zoom || 16});`);
      injectJS(`window.showMyLocationDot(${lat}, ${lng});`);
    },
    startAutoFit: () => injectJS('window.enableAutoFit();'),
    stopAutoFit: () => injectJS('window.disableAutoFit();'),
    setNavRemainingDistance: (dist: number, approachingTurn: boolean) => injectJS(`window.setNavRemainingDistance(${dist}, ${!!approachingTurn});`),
    setNavSpeed: (speedMps: number) => injectJS(`window.setNavSpeed(${speedMps});`),
    setNavMode: (mode: string) => injectJS(`window.setNavMode(${JSON.stringify(mode)});`),
    setNavContext: (remainingDistance: number, approachingTurn: boolean, mode: string, speedMps: number) => injectJS(`window.setNavContext(${remainingDistance}, ${!!approachingTurn}, ${JSON.stringify(mode)}, ${speedMps});`),
    clearAll: () => injectJS('window.clearAll();'),
    clearOverlays: () => injectJS('window.clearOverlays();'),
    requestAmapLocation: requestAmapLocationAsync,
    injectJavaScript: (script: string) => injectJS(script),
  }));

  return (
    <View style={styles.container}>
      <WebView
        key={webViewKey}
        ref={webViewRef}
        source={{ html: HTML_TEMPLATE }}
        style={styles.map}
        onMessage={handleMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        geolocationEnabled={true}
        originWhitelist={['*']}
        mixedContentMode='compatibility'
        allowFileAccess={true}
        cacheEnabled={true}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        onError={handleError}
        onHttpError={handleHttpError}
      />
      {!mapReady && (
        <View style={styles.loading}>
          {loadError ? (
            <>
              <Text style={styles.errorText}>{loadError}</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={retryLoad}>
                <Text style={styles.retryBtnText}>重新加载</Text>
              </TouchableOpacity>
            </>
          ) : (
            <ActivityIndicator size="large" color="#007AFF" />
          )}
        </View>
      )}
    </View>
  );
});

export default _MapView;

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  loading: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f5f5f5', padding: 20 },
  errorText: { color: '#E53935', fontSize: 14, textAlign: 'center', marginBottom: 16 },
  retryBtn: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#007AFF',
    borderRadius: 8,
  },
  retryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});