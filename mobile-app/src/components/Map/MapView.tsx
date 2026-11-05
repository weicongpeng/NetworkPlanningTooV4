import React, { forwardRef, useImperativeHandle, useRef, useEffect, useCallback, useState } from 'react';
import { View, StyleSheet, Text, ActivityIndicator, TouchableOpacity } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { useMapStore } from '../../store/mapStore';
import { resetNavUiAutoHide } from '../../services/navigationService';
import { wgs84ToGcj02 } from '../../utils/coordinate';

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

const _T0 = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>*{margin:0;padding:0;}html,body,#map{width:100%;height:100%;overflow:hidden}#map{touch-action:manipulation}.amap-logo,.amap-copyright{display:none!important}</style><script id="amap-script" src="https://webapi.amap.com/maps?v=2.0&key=9fa8b08372c3c764fd14d0bc74862ad1&callback=onAMapLoaded&plugin=AMap.Geolocation" onerror="window._amapScriptError=true"></script></head><body><div id="map"></div><script>(function(){
var map=null;
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
window.updateMarkers=function(markers){
_log('updateMarkers:'+markers.length);
if(!map||!window.markerGroup)return;
window.markerGroup.clearOverlays();
for(var i=0;i<markers.length;i++){
var m=markers[i];var gcj=wgs84ToGcj02(m.lat,m.lng);
var dot=new AMap.CircleMarker({center:[gcj[1],gcj[0]],radius:6,fillColor:'#E53935',fillOpacity:1,strokeColor:'#fff',strokeWeight:2,zIndex:90,extData:m});
(function(d,md){d.on('click',function(){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'markerClick',marker:md}))})})(dot,m);
window.markerGroup.addOverlay(dot);
/* Add name label for each marker */
if(m.name){
var label=document.createElement('div');
label.style.cssText='background:rgba(229,57,53,0.9);color:#fff;padding:2px 6px;border-radius:8px;font-size:10px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.2);transform:translateX(-50%)';
label.textContent=m.name;
var labelMarker=new AMap.Marker({position:[gcj[1],gcj[0]],content:label,offset:new AMap.Pixel(0,-28),zIndex:91,bubble:true});
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
window.measureGroup.addOverlay(new AMap.Polyline({path:path,strokeColor:'#E53935',strokeWeight:3,strokeStyle:'dashed',strokeDash:[5,5]}));
for(var i=0;i<points.length;i++){
window.measureGroup.addOverlay(new AMap.CircleMarker({center:[points[i].lng,points[i].lat],radius:6,fillColor:'#E53935',fillOpacity:1,strokeColor:'#fff',strokeWeight:2}))
}
/* Add "起点" label at first point */
if(points.length>=1){
var first=points[0];
var startLabel=document.createElement('div');
startLabel.style.cssText='background:rgba(229,57,53,0.9);color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.2);transform:translateX(-50%)';
startLabel.textContent='起点';
var startMarker=new AMap.Marker({position:[first.lng,first.lat],content:startLabel,offset:new AMap.Pixel(0,-28),zIndex:111,bubble:true});
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
'<button onclick="event.stopPropagation();window.handleMeasureClear()" style="background:#FFEBEE;color:#E53935;border:1px solid #EF9A9A;border-radius:4px;padding:4px 10px;margin-left:6px;font-size:12px;cursor:pointer">清除</button>';
window._measurePanelMarker=new AMap.Marker({position:[last.lng,last.lat],content:panel,offset:new AMap.Pixel(0,-45),zIndex:120,bubble:false});
map.add(window._measurePanelMarker)
}
};
window.updateSearchMarker=function(marker){
if(window._searchMarkerDot){map.remove(window._searchMarkerDot);window._searchMarkerDot=null}
if(window._searchMarker){map.remove(window._searchMarker);window._searchMarker=null}
if(!marker)return
var lat=marker.lat,lng=marker.lng;
var dot=new AMap.CircleMarker({center:[lng,lat],radius:6,fillColor:'#E53935',fillOpacity:1,strokeColor:'#fff',strokeWeight:2,zIndex:200,bubble:true});
map.add(dot);
window._searchMarkerDot=dot;
var label=document.createElement('div');
label.style.cssText='background:rgba(255,59,48,0.5);color:#fff;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.15);border:1.5px solid rgba(255,255,255,0.6);transform:translateX(-50%)';
label.innerHTML=marker.name||'搜索结果';
window._searchMarker=new AMap.Marker({position:[lng,lat],content:label,offset:new AMap.Pixel(0,-28),zIndex:200,bubble:true});
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
  return new AMap.Polyline({path:pts,strokeColor:color||'#4CAF50',strokeWeight:10,strokeOpacity:opacity==null?0.9:opacity,lineJoin:'round',lineCap:'round',zIndex:50})
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
  if(_destinationPin){map.remove(_destinationPin);_destinationPin=null}
  if(_destinationMarker){map.remove(_destinationMarker);_destinationMarker=null}
  _destinationPin=new AMap.CircleMarker({center:[lng,lat],radius:6,fillColor:'#E53935',fillOpacity:1,strokeColor:'#fff',strokeWeight:2,zIndex:148});
  map.add(_destinationPin);
  var label=document.createElement('div');
  label.style.cssText='background:#E53935;color:#fff;padding:4px 10px;border-radius:14px;font-size:12px;font-weight:600;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.3);border:1.5px solid #fff;transform:translateX(-50%);position:relative;';
  label.innerHTML=(name||'')+'<div style="position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid #E53935"></div>';
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
window.deselectSector()
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
window.deselectSector()
};
window.handleMeasureFinish=function(){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'measureFinish'}))};
window.handleMeasureClear=function(){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'measureClear'}))};
/* Init */
function initMap(){
try{
_log('Init map');
map=new AMap.Map('map',{zoom:12,center:[114.7,23.74],viewMode:'2D',resizeEnable:true});
window.map=map;
window.sectorGroup=new AMap.OverlayGroup();window.sectorGroup.setMap(map);
window.markerGroup=new AMap.OverlayGroup();window.markerGroup.setMap(map);
window.measureGroup=new AMap.OverlayGroup();window.measureGroup.setMap(map);
_routeGroup=new AMap.OverlayGroup();_routeGroup.setMap(map);
map.on('complete',function(){_log('Tiles loaded')});
/* Map click with hit-testing for sectors */
map.on('click',function(e){
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

  // Sync all data to WebView — only used for initial sync on mapReady
  // Reads from store directly to avoid stale closure issues
  const syncAllData = useCallback(() => {
    if (!mapReady) return;
    const state = useMapStore.getState();
    const visibleLte = state.layers?.lte?.visible ? state.lteSectors : [];
    const visibleNr = state.layers?.nr?.visible ? state.nrSectors : [];
    const allSectors = [...visibleLte, ...visibleNr];
    injectJS(`window.updateSectors(${JSON.stringify(allSectors)});`);
    injectJS(`window.updateMarkers(${JSON.stringify(state.markers || [])});`);
    injectJS(`window.updateMeasurePoints(${JSON.stringify(state.measurePoints || [])}, ${!!state.measureMode}, ${!!state.measureFinished});`);
    injectJS(`window.updateMarkerMode(${!!state.markerMode});`);
    if (state.searchMarker) injectJS(`window.updateSearchMarker(${JSON.stringify(state.searchMarker)});`);
    else injectJS('window.updateSearchMarker(null);');
  }, [mapReady, injectJS]);

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
        case 'sectorClick':
          console.log('[MapView] sectorClick:', data.sector?.id);
          setSelectedSector?.(data.sector);
          resetNavUiAutoHide();
          break;
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
  }, [setSelectedSector]);

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
    const visibleLte = layers?.lte?.visible ? lteSectors : [];
    const visibleNr = layers?.nr?.visible ? nrSectors : [];
    injectJS(`window.updateSectors(${JSON.stringify([...visibleLte, ...visibleNr])});`);
  }, [lteSectors, nrSectors, layers?.lte?.visible, layers?.nr?.visible, mapReady]);

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

  // Sector selection
  useEffect(() => {
    if (!mapReady) return;
    if (selectedSector?.id) injectJS(`window.selectSector('${selectedSector.id}');`);
    else injectJS('window.deselectSector();');
  }, [selectedSector, mapReady]);

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