import React, { forwardRef, useImperativeHandle, useRef, useEffect, useCallback, useState } from 'react';
import { View, StyleSheet, Text, ActivityIndicator } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { useMapStore } from '../../store/mapStore';
import { resetNavUiAutoHide } from '../../services/navigationService';
import { wgs84ToGcj02 } from '../../utils/coordinate';

export interface MapViewRef {
  moveCamera: (lat: number, lng: number, zoom?: number) => void;
  addRoute: (polyline: [number, number][]) => void;
  clearRoute: () => void;
  showDestinationMarker: (lat: number, lng: number, name: string) => void;
  hideDestinationMarker: () => void;
  updateUserLocation: (lat: number, lng: number, heading?: number) => void;
  clearUserLocation: () => void;
  fitRouteBounds: (polyline: [number, number][], totalDistance?: number) => void;
  locateMe: (lat: number, lng: number, zoom?: number) => void;
  startAutoFit: () => void;
  stopAutoFit: () => void;
  injectJavaScript: (script: string) => void;
  /** 更新导航剩余距离，供 auto-fit 动态 zoom 使用 */
  setNavRemainingDistance: (dist: number) => void;
}

interface Props {
  initialCenter?: [number, number];
  showSatellite?: boolean;
  onMapPress?: (lat: number, lng: number) => void;
  onLongPress?: (lat: number, lng: number) => void;
  onMarkerClick?: (marker: any) => void;
  onMeasureFinish?: () => void;
  onMeasureClear?: () => void;
  onSectorOverlap?: (sectors: any[], lat: number, lng: number) => void;
  onMapInteraction?: () => void;
  onMapReady?: () => void;
}

const AMAP_KEY = '9fa8b08372c3c764fd14d0bc74862ad1';
const AMAP_SECRET = 'f8929d799c3eca85e0f78d3e6b48be06';

const HTML_TEMPLATE = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #map { width: 100%; height: 100%; overflow: hidden; }
    .measure-label {
      background: rgba(0,0,0,0.7);
      color: #fff;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      white-space: nowrap;
    }
    .search-label {
      color: #333;
      font-size: 12px;
      font-weight: bold;
      white-space: nowrap;
      text-shadow: 0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff;
    }
    .marker-label {
      color: #333;
      font-size: 12px;
      font-weight: bold;
      white-space: nowrap;
      text-shadow: 0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff;
    }
    .measure-panel {
      background: rgba(255,255,255,0.95);
      border-radius: 8px;
      padding: 6px 10px;
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 6px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      font-size: 12px;
      white-space: nowrap;
    }
    .measure-panel .dist {
      color: #E53935;
      font-weight: bold;
      font-size: 13px;
      margin-right: 4px;
    }
    .measure-panel .btn {
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      border: none;
      cursor: pointer;
    }
    .measure-panel .btn-finish {
      background: #007AFF;
      color: #fff;
    }
    .measure-panel .btn-clear {
      background: #FFEBEE;
      color: #E53935;
      border: 1px solid #EF9A9A;
    }
    .amap-logo { display: none !important; }
    .amap-copyright { display: none !important; }
  </style>
  <script id="amap-script"
    src="https://webapi.amap.com/maps?v=2.0&key=${AMAP_KEY}&callback=onAMapLoaded&plugin=AMap.Geolocation"
    onload="window._amapScriptLoaded=true;"
    onerror="window._amapScriptError=true;">
  </script>
</head>
<body>
  <div id="map"></div>
  <script>
    (function() {
      var map = null;
      var sectorOverlayGroup = null;
      var markerOverlayGroup = null;
      var measureOverlayGroup = null;
      var routeOverlayGroup = null;
      var userLocationMarker = null;
      var searchMarkerObj = null;
      var currentSectorData = '';
      var currentMarkerData = '';
      var currentMeasureData = '';
      var longPressTimer = null;
      var isLongPress = false;
      var sectorOverlayMap = {};
      var currentSelectedSectorId = null;
      var mapRecentlyMoved = false;
      var mapMoveResetTimer = null;
      var isCurrentlyDragging = false;
      var touchStartPos = null;
      var touchStartTime = 0;
      var lastTapTime = 0;
      var touchHandled = false;

      // Auto-fit variables: 导航中地图跟随用户位置
      var _autoFitTimer = null;
      var _autoFitEnabled = false;
      var _currentUserPos = null;         // [lat, lng] from updateUserLocation
      var _programmaticMove = false;      // 防止程序移动触发 auto-fit 循环
      var _navDefaultZoom = 18;           // 导航中默认zoom值
      var _manualInteracting = false;     // 用户正在手动操作地图（拖拽/缩放）
      var _manualInteractionTimeout = null; // 手动操作结束后的延迟计时器

      function log(msg) {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'log', message: msg }));
        }
      }

      // WGS84 -> GCJ-02 coordinate conversion (China GPS offset)
      function outOfChina(lat, lng) {
        return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
      }
      function transformLat(lng, lat) {
        var ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
        ret += (20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(lat * Math.PI) + 40.0 * Math.sin(lat / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (160.0 * Math.sin(lat / 12.0 * Math.PI) + 320 * Math.sin(lat * Math.PI / 30.0)) * 2.0 / 3.0;
        return ret;
      }
      function transformLng(lng, lat) {
        var ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
        ret += (20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(lng * Math.PI) + 40.0 * Math.sin(lng / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (150.0 * Math.sin(lng / 12.0 * Math.PI) + 300.0 * Math.sin(lng / 30.0 * Math.PI)) * 2.0 / 3.0;
        return ret;
      }
      function wgs84ToGcj02(lat, lng) {
        if (outOfChina(lat, lng)) {
          return [lat, lng];
        }
        var dlat = transformLat(lng - 105.0, lat - 35.0);
        var dlng = transformLng(lng - 105.0, lat - 35.0);
        var radlat = lat / 180.0 * Math.PI;
        var magic = Math.sin(radlat);
        magic = 1 - 0.00669342162296594323 * magic * magic;
        var sqrtmagic = Math.sqrt(magic);
        dlat = (dlat * 180.0) / ((6378245.0 * (1 - 0.00669342162296594323)) / (magic * sqrtmagic) * Math.PI);
        dlng = (dlng * 180.0) / (6378245.0 / sqrtmagic * Math.cos(radlat) * Math.PI);
        var mglat = lat + dlat;
        var mglng = lng + dlng;
        return [mglat, mglng];
      }

      var measureActionInProgress = false;

      window.handleMeasureFinish = function() {
        measureActionInProgress = true;
        setTimeout(function() { measureActionInProgress = false; }, 300);
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'measureFinish' }));
        }
      };
      window.handleMeasureClear = function() {
        measureActionInProgress = true;
        setTimeout(function() { measureActionInProgress = false; }, 300);
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'measureClear' }));
        }
      };

      // Unified tap handler: checks sectors first, then falls back to empty-space handling
      // Uses dedup to prevent duplicate processing from overlapping event sources
      function handleTapInternal(lat, lng, source) {
        try {
          var now = Date.now();
          // 去重：300ms 内的同一源点击跳过（touchend 和 click 间隔通常 < 300ms）
          if (now - lastTapTime < 300) {
            log('tap dedup skipped (' + source + '): too soon after last tap');
            return false;
          }
          lastTapTime = now;

          log('tap (' + source + '): ' + lat.toFixed(5) + ',' + lng.toFixed(5));

          var matching = getSectorsAtPoint(lng, lat);
          log('tap sectors: ' + matching.length + (matching.length > 0 ? ' ids=' + matching.map(function(e) { return e.data.id; }).join(',') : ''));

          if (matching.length >= 1) {
            // 即使有多个匹配，getSectorsAtPoint 已经返回最匹配的一个
            window.selectSector(matching[0].data.id);
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'sectorClick', sector: matching[0].data
              }));
            }
            return true;
          } else if (!mapRecentlyMoved) {
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'mapClick', lat: lat, lng: lng
              }));
            }
          }
          mapRecentlyMoved = false;
          if (mapMoveResetTimer) { clearTimeout(mapMoveResetTimer); mapMoveResetTimer = null; }
          return false;
        } catch (err) {
          log('tap error: ' + (err.message || err));
          return false;
        }
      }

      function calculateSectorPoints(lat, lng, azimuth, beamwidth, radius) {
        var points = [];
        // 地理方位角：0°=正北，顺时针增加
        // 数学角度：0°=正东，逆时针增加
        // 转换：mathAngle = 90 - azimuth
        var startAngle = 90 - azimuth - beamwidth / 2;
        var endAngle = 90 - azimuth + beamwidth / 2;
        points.push([lng, lat]);
        for (var a = startAngle; a <= endAngle; a += 5) {
          var rad = a * Math.PI / 180;
          var dx = radius * Math.cos(rad);
          var dy = radius * Math.sin(rad);
          var dLng = dx / (111320 * Math.cos(lat * Math.PI / 180));
          var dLat = dy / 110540;
          points.push([lng + dLng, lat + dLat]);
        }
        points.push([lng, lat]);
        return points;
      }

      function initMap() {
        try {
          var mapContainer = document.getElementById('map');
          log('Container size: ' + mapContainer.offsetWidth + 'x' + mapContainer.offsetHeight);

          map = new AMap.Map('map', {
            zoom: 12,
            center: [114.7004, 23.7435],
            viewMode: '2D',
            resizeEnable: true,
          });
          window.map = map;
          log('Map initialized');

          map.on('complete', function() {
            log('Map tiles loaded');
          });

          sectorOverlayGroup = new AMap.OverlayGroup();
          sectorOverlayGroup.setMap(map);
          markerOverlayGroup = new AMap.OverlayGroup();
          markerOverlayGroup.setMap(map);
          measureOverlayGroup = new AMap.OverlayGroup();
          measureOverlayGroup.setMap(map);
          routeOverlayGroup = new AMap.OverlayGroup();
          routeOverlayGroup.setMap(map);

          // Resize on window resize
          window.addEventListener('resize', function() {
            if (map) map.resize();
          });

          // Use map's native events - no custom touch handling to avoid interfering with map gestures
          // Track map move/drag to distinguish from click
          map.on('mapmove', function() {
            if (mapMoveResetTimer) {
              clearTimeout(mapMoveResetTimer);
            }
            mapRecentlyMoved = true;
            // Notify RN to close menus when map moves
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mapInteraction' }));
            }
            mapMoveResetTimer = setTimeout(function() {
              mapRecentlyMoved = false;
              mapMoveResetTimer = null;
            }, 500);
          });

          // Long press detection via map
          map.on('longpress', function(e) {
            isLongPress = true;
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'mapLongPress',
                lat: e.lnglat.getLat(),
                lng: e.lnglat.getLng()
              }));
            }
          });

          // Auto-fit: 用户拖拽/缩放时暂停实时跟随，操作结束后3秒恢复
          // 程序性移动（moveCamera/fitRouteBounds）不触发UI恢复
          map.on('dragstart', function() {
            _programmaticMove = false;
            _manualInteracting = true;
            clearAutoFitTimer();
            if (_manualInteractionTimeout) { clearTimeout(_manualInteractionTimeout); _manualInteractionTimeout = null; }
            if (!_programmaticMove && window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mapInteraction' }));
            }
          });
          map.on('dragend', function() { 
            _manualInteracting = false;
            startAutoFitTimer(); 
          });
          map.on('zoomstart', function() {
            _manualInteracting = true;
            clearAutoFitTimer();
            if (_manualInteractionTimeout) { clearTimeout(_manualInteractionTimeout); _manualInteractionTimeout = null; }
            if (!_programmaticMove && window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mapInteraction' }));
            }
          });
          map.on('zoomend', function() {
            if (_programmaticMove) { _programmaticMove = false; return; }
            _manualInteracting = false;
            startAutoFitTimer();
            // 缩放结束后重新计算箭头间隔（只要有路线且代次匹配才更新）
            if (_currentRoutePolyline && _currentRoutePolyline.length >= 2) {
              updateRouteArrows(_currentRoutePolyline, _routeGeneration);
            }
          });

          // 导航视窗动态调整：根据剩余距离计算最佳 zoom，让用户看清近端路线
          window.getNavZoom = function(remainingDistance) {
            if (!remainingDistance || remainingDistance <= 0) return 17;
            // 剩余距离越短，zoom 越大（地图越放大），便于看清近端路线细节
            if (remainingDistance < 50) return 19;
            if (remainingDistance < 120) return 18;
            if (remainingDistance < 250) return 17;
            if (remainingDistance < 500) return 16;
            if (remainingDistance < 1000) return 15;
            if (remainingDistance < 2000) return 14;
            if (remainingDistance < 5000) return 13;
            return 12;
          };

          // ---- RELIABLE TAP DETECTION ----
          // On mobile WebView, AMap overlay click events are unreliable because the
          // Canvas renderer doesn't dispatch click events for Polygon/Circle touches.
          // We use DOM-level touch events on the map container which ALWAYS fire.
          // Combined with our own hit-testing (getSectorsAtPoint), this works reliably.

          // Touchstart: track position/time for tap-vs-drag distinction
          var container = map.getContainer();
          container.addEventListener('touchstart', function(e) {
            if (e.changedTouches.length === 1) {
              touchStartPos = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
              touchStartTime = Date.now();
            } else {
              touchStartPos = null;
            }
          }, { passive: true });

          // Touchend: detect tap and convert to geographic coordinates
          container.addEventListener('touchend', function(e) {
            try {
              if (!touchStartPos || e.changedTouches.length > 1) {
                touchStartPos = null;
                return;
              }

              // Skip taps on UI overlays (measure panel, etc.)
              var target = e.target;
              while (target) {
                if (target.classList && (
                  target.classList.contains('measure-panel') ||
                  target.classList.contains('measure-label') ||
                  target.classList.contains('btn')
                )) {
                  log('touchend skipped: UI overlay tap');
                  touchStartPos = null;
                  return;
                }
                target = target.parentElement;
              }

              var touch = e.changedTouches[0];
              var dx = touch.clientX - touchStartPos.x;
              var dy = touch.clientY - touchStartPos.y;
              var dt = Date.now() - touchStartTime;
              touchStartPos = null;
              log('touchend dx=' + Math.abs(dx).toFixed(1) + ' dy=' + Math.abs(dy).toFixed(1) + ' dt=' + dt);
              if (Math.abs(dx) > 40 || Math.abs(dy) > 40 || dt > 800) {
                log('touchend rejected: drag or long press');
                return;
              }

              var rect = container.getBoundingClientRect();
              var pixelX = touch.clientX - rect.left;
              var pixelY = touch.clientY - rect.top;
              // Use containerToLngLat (screen pixel relative to map container) instead of pixelToLngLat (world pixel)
              var lnglat;
              if (map.containerToLngLat) {
                lnglat = map.containerToLngLat(new AMap.Pixel(pixelX, pixelY));
              } else {
                log('containerToLngLat not available, falling back to pixelToLngLat');
                lnglat = map.pixelToLngLat(new AMap.Pixel(pixelX, pixelY));
              }
              log('touch: pixel=(' + pixelX.toFixed(0) + ',' + pixelY.toFixed(0) + ') lnglat=(' + lnglat.getLng().toFixed(5) + ',' + lnglat.getLat().toFixed(5) + ')');
              var detected = handleTapInternal(lnglat.getLat(), lnglat.getLng(), 'touchend');
              // 只有在 touchend 检测到扇区时才抑制 map.on('click')，否则让 map.on('click') 兜底
              if (detected) {
                touchHandled = true;
                setTimeout(function() { touchHandled = false; }, 300);
              }
            } catch (err) {
              log('touch error: ' + (err.message || err));
            }
          }, { passive: true });

          // Touchcancel: reset tracking state when system interrupts touch
          container.addEventListener('touchcancel', function(e) {
            touchStartPos = null;
          }, { passive: true });

          // Map click fallback: handles desktop browsers and non-touch scenarios
          // On mobile, touchend handles taps reliably; click may duplicate so we guard it
          map.on('click', function(e) {
            if (touchHandled) {
              log('map.click suppressed (touch handled)');
              return;
            }
            if (measureActionInProgress) {
              log('map.click suppressed (measure action in progress)');
              return;
            }
            log('map.click: ' + e.lnglat.getLat().toFixed(5) + ',' + e.lnglat.getLng().toFixed(5));
            handleTapInternal(e.lnglat.getLat(), e.lnglat.getLng(), 'mapclick');
          });

          // Notify RN that map is ready
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mapReady' }));
          }
        } catch (err) {
          log('Init error: ' + err.message);
        }
      }

      var checkCount = 0;
      function checkAMap() {
        checkCount++;
        if (typeof AMap !== 'undefined') {
          log('AMap ready after ' + checkCount + ' checks');
          initMap();
          return;
        }
        if (window._amapScriptError) {
          log('AMap script load error after ' + checkCount + ' checks');
          return;
        }
        if (checkCount > 100) {
          log('AMap check timeout (20s)');
          return;
        }
        log('AMap not ready (' + checkCount + '), retrying...');
        setTimeout(checkAMap, 200);
      }

      window.onAMapLoaded = function() {
        log('onAMapLoaded callback fired');
        checkAMap();
      };

      // Fallback: if callback never fires, start polling
      setTimeout(checkAMap, 2000);

      window.updateSectors = function(sectors) {
        if (!map) { log('updateSectors: map not ready'); return; }
        var jsonStr = JSON.stringify(sectors);
        if (currentSectorData === jsonStr) return;
        currentSectorData = jsonStr;
        log('updateSectors: ' + sectors.length);

        sectorOverlayGroup.clearOverlays();
        sectorOverlayMap = {};
        var overlays = [];
        for (var k = 0; k < sectors.length; k++) {
          var sector = sectors[k];
          var color = sector.networkType === 'LTE' ? '#4CAF50' : '#2196F3';
          var strokeColor = sector.networkType === 'LTE' ? '#2E7D32' : '#1565C0';

          // WGS84 -> GCJ-02 conversion for AMap display and hit-testing
          var gcj = wgs84ToGcj02(sector.latitude, sector.longitude);
          var gcjLat = gcj[0];
          var gcjLng = gcj[1];

          var overlay;
          var path = null;
          var sectorId = sector.id || ('sector-' + k);
          if (sector.cell_cover_type === 4) {
            overlay = new AMap.Circle({
              center: [gcjLng, gcjLat],
              radius: 30,
              fillColor: color,
              fillOpacity: 0.4,
              strokeColor: strokeColor,
              strokeWeight: 1,
              cursor: 'pointer',
              extData: sector
            });
          } else {
            var azimuth = (sector.azimuth === undefined || sector.azimuth === null) ? 0 : Number(sector.azimuth);
            var beamwidth = (sector.beamwidth === undefined || sector.beamwidth === null) ? 65 : Number(sector.beamwidth);
            path = calculateSectorPoints(gcjLat, gcjLng, azimuth, beamwidth, 60);
            overlay = new AMap.Polygon({
              path: path,
              fillColor: color,
              fillOpacity: 0.35,
              strokeColor: strokeColor,
              strokeWeight: 1,
              cursor: 'pointer',
              extData: sector
            });
          }

          // Bind click event directly on overlay (like desktop Leaflet approach)
          (function(currentSector) {
            overlay.on('click', function(e) {
              if (e && e.stopPropagation) e.stopPropagation();
              var now = Date.now();
              if (now - lastTapTime < 300) return;
              lastTapTime = now;
              log('overlay.click: ' + currentSector.id);
              window.selectSector(currentSector.id);
              if (window.ReactNativeWebView) {
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'sectorClick', sector: currentSector
                }));
              }
            });
          })(sector);

          overlays.push(overlay);
          sectorOverlayMap[sectorId] = {
            overlay: overlay,
            data: sector,
            gcjLat: gcjLat,
            gcjLng: gcjLng,
            path: path
          };
        }
        if (overlays.length > 0) {
          sectorOverlayGroup.addOverlays(overlays);
        }
        // Re-apply highlight if the previously selected sector is still in view
        if (currentSelectedSectorId && sectorOverlayMap[currentSelectedSectorId]) {
          var sel = sectorOverlayMap[currentSelectedSectorId];
          if (sel.data.cell_cover_type === 4) {
            sel.overlay.setOptions({ fillColor: '#E53935', fillOpacity: 0.6, strokeColor: '#B71C1C', strokeWeight: 3, radius: 50 });
          } else {
            sel.overlay.setOptions({ fillColor: '#E53935', fillOpacity: 0.55, strokeColor: '#B71C1C', strokeWeight: 3 });
          }
        }
      };

      function pointInSector(lng, lat, entry) {
        try {
          if (!entry || !entry.data) return false;
          var sector = entry.data;
          // Use GCJ-02 coordinates for hit-testing (same coordinate system as map click)
          var gcjLat = entry.gcjLat;
          var gcjLng = entry.gcjLng;
          if (gcjLat === undefined || gcjLng === undefined) {
            // Fallback to raw data if GCJ coords missing (should not happen)
            gcjLat = sector.latitude;
            gcjLng = sector.longitude;
          }
          // Quick bounding box check (~1km) to skip distant sectors
          if (Math.abs(gcjLng - lng) > 0.01 || Math.abs(gcjLat - lat) > 0.01) return false;
          if (sector.cell_cover_type === 4) {
            // Circle (indoor) - check haversine distance <= 30m
            var R = 6371000;
            var dLat = (lat - gcjLat) * Math.PI / 180;
            var dLon = (lng - gcjLng) * Math.PI / 180;
            var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                    Math.cos(gcjLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) *
                    Math.sin(dLon/2) * Math.sin(dLon/2);
            var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return (R * c) <= 30;
          } else {
            // Polygon (outdoor) - ray casting (path is already in GCJ-02)
            var poly = entry.path;
            if (!poly || !Array.isArray(poly) || poly.length < 3) {
              log('pointInSector: invalid path for ' + (sector.id || 'unknown'));
              return false;
            }
            var inside = false;
            for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              var xi = poly[i][0], yi = poly[i][1];
              var xj = poly[j][0], yj = poly[j][1];
              // Skip if edge is horizontal (avoid division by zero)
              if (yj === yi) continue;
              if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
                inside = !inside;
              }
            }
            return inside;
          }
        } catch (err) {
          log('pointInSector error: ' + (err.message || err));
          return false;
        }
      }

      function getDistanceMeters(lat1, lon1, lat2, lon2) {
        var R = 6371000;
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLon = (lon2 - lon1) * Math.PI / 180;
        var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
      }

      // 计算从扇区中心到点击点的方位角（度）
      function getBearing(lat1, lon1, lat2, lon2) {
        var dLon = (lon2 - lon1) * Math.PI / 180;
        var lat1r = lat1 * Math.PI / 180;
        var lat2r = lat2 * Math.PI / 180;
        var y = Math.sin(dLon) * Math.cos(lat2r);
        var x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon);
        var bearing = Math.atan2(y, x) * 180 / Math.PI;
        return (bearing + 360) % 360;
      }

      // 计算方位角差异（考虑 360° 环绕）
      function azimuthDiff(a1, a2) {
        var diff = Math.abs(a1 - a2);
        return diff > 180 ? 360 - diff : diff;
      }

      function getSectorsAtPoint(lng, lat) {
        var result = [];
        var minDistance = Infinity;
        var closestEntry = null;

        for (var id in sectorOverlayMap) {
          if (!sectorOverlayMap.hasOwnProperty(id)) continue;
          var entry = sectorOverlayMap[id];
          var sector = entry.data;
          var gcjLat = entry.gcjLat !== undefined ? entry.gcjLat : sector.latitude;
          var gcjLng = entry.gcjLng !== undefined ? entry.gcjLng : sector.longitude;

          // 方法1：精确的射线检测（多边形/圆形内）
          if (pointInSector(lng, lat, entry)) {
            result.push(entry);
            continue;
          }

          // 方法2：容错检测 - 如果点击位置在扇区中心 120 米范围内，也认为是命中
          var dist = getDistanceMeters(gcjLat, gcjLng, lat, lng);
          if (dist < 120 && dist < minDistance) {
            minDistance = dist;
            closestEntry = entry;
          }
        }

        // 如果精确检测没有命中，但容错检测有最近项，返回最近项
        if (result.length === 0 && closestEntry) {
          result.push(closestEntry);
          return result;
        }

        // 如果命中多个扇区，选择"最匹配"的一个（点击方向与扇区方位角最接近）
        if (result.length > 1) {
          var bestMatch = result[0];
          var bestDiff = Infinity;
          for (var i = 0; i < result.length; i++) {
            var sector = result[i].data;
            var gcjLat = result[i].gcjLat !== undefined ? result[i].gcjLat : sector.latitude;
            var gcjLng = result[i].gcjLng !== undefined ? result[i].gcjLng : sector.longitude;
            if (sector.cell_cover_type === 4) {
              // 室内扇区（圆形），选择最近的
              var dist = getDistanceMeters(gcjLat, gcjLng, lat, lng);
              if (dist < bestDiff) {
                bestDiff = dist;
                bestMatch = result[i];
              }
            } else if (sector.azimuth !== undefined && sector.azimuth !== null) {
              // 室外扇区，选择方位角与点击方向最接近的
              var clickBearing = getBearing(gcjLat, gcjLng, lat, lng);
              var diff = azimuthDiff(clickBearing, sector.azimuth);
              if (diff < bestDiff) {
                bestDiff = diff;
                bestMatch = result[i];
              }
            }
          }
          return [bestMatch];
        }

        return result;
      }

      window.selectSector = function(id) {
        // Deselect previous
        if (currentSelectedSectorId && sectorOverlayMap[currentSelectedSectorId]) {
          var prev = sectorOverlayMap[currentSelectedSectorId];
          var ps = prev.data;
          var pc = ps.networkType === 'LTE' ? '#4CAF50' : '#2196F3';
          var psC = ps.networkType === 'LTE' ? '#2E7D32' : '#1565C0';
          if (ps.cell_cover_type === 4) {
            prev.overlay.setOptions({ fillColor: pc, fillOpacity: 0.4, strokeColor: psC, strokeWeight: 1, radius: 30 });
          } else {
            prev.overlay.setOptions({ fillColor: pc, fillOpacity: 0.35, strokeColor: psC, strokeWeight: 1 });
          }
        }
        currentSelectedSectorId = null;

        // Select new
        if (id && sectorOverlayMap[id]) {
          var entry = sectorOverlayMap[id];
          if (entry.data.cell_cover_type === 4) {
            entry.overlay.setOptions({ fillColor: '#E53935', fillOpacity: 0.6, strokeColor: '#B71C1C', strokeWeight: 3, radius: 50 });
          } else {
            entry.overlay.setOptions({ fillColor: '#E53935', fillOpacity: 0.55, strokeColor: '#B71C1C', strokeWeight: 3 });
          }
          currentSelectedSectorId = id;
        }
      };

      window.deselectSector = function() {
        if (currentSelectedSectorId) {
          window.selectSector(null);
        }
      };

      window.updateMarkers = function(markers) {
        if (!map) return;
        var jsonStr = JSON.stringify(markers);
        if (currentMarkerData === jsonStr) return;
        currentMarkerData = jsonStr;

        markerOverlayGroup.clearOverlays();
        for (var i = 0; i < markers.length; i++) {
          var m = markers[i];
          // markers 存储为 WGS84，显示前转换为 GCJ-02
          var gcj = wgs84ToGcj02(m.lat, m.lng);
          var gcjLat = gcj[0];
          var gcjLng = gcj[1];
          var dot = new AMap.CircleMarker({
            center: [gcjLng, gcjLat],
            radius: 8,
            fillColor: '#E53935',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 2,
            zIndex: 90,
            extData: m
          });
          (function(dotObj, markerData) {
            dotObj.on('click', function(e) {
              if (e && e.stopPropagation) e.stopPropagation();
              if (window.ReactNativeWebView) {
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'markerClick', marker: markerData }));
              }
            });
          })(dot, m);
          markerOverlayGroup.addOverlay(dot);

          var label = new AMap.Marker({
            position: [gcjLng, gcjLat],
            offset: new AMap.Pixel(0, -22),
            content: '<div class="marker-label">' + ((m.name && m.name.length > 0) ? m.name : '标记 ' + (i + 1)) + '</div>',
            clickable: false,
            zIndex: 91
          });
          markerOverlayGroup.addOverlay(label);
        }
      };

      function formatDist(meters) {
        if (meters === null || meters === undefined) return '0m';
        return meters >= 1000 ? (meters / 1000).toFixed(2) + 'km' : Math.round(meters) + 'm';
      }

      window.updateMeasurePoints = function(points, mode, finished) {
        if (!map) return;
        var jsonStr = JSON.stringify(points);
        if (currentMeasureData === jsonStr && !mode && !finished) return;
        currentMeasureData = jsonStr;

        measureOverlayGroup.clearOverlays();
        if (points.length === 0) return;

        var path = points.map(function(p) { return [p.lng, p.lat]; });
        var polyline = new AMap.Polyline({
          path: path,
          strokeColor: '#E53935',
          strokeWeight: 3,
          strokeStyle: 'dashed',
          strokeDash: [5, 5],
          lineJoin: 'round'
        });
        measureOverlayGroup.addOverlay(polyline);

        for (var i = 0; i < points.length; i++) {
          var pt = points[i];
          var dot = new AMap.CircleMarker({
            center: [pt.lng, pt.lat],
            radius: 6,
            fillColor: '#E53935',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 2
          });
          measureOverlayGroup.addOverlay(dot);
        }

        if (points.length >= 1) {
          var startLabel = new AMap.Marker({
            position: [points[0].lng, points[0].lat],
            offset: new AMap.Pixel(-15, -30),
            content: '<div class="measure-label" style="background:rgba(76,175,80,0.85);">起点</div>',
            clickable: false
          });
          measureOverlayGroup.addOverlay(startLabel);
        }

        if (points.length >= 2) {
          var lastPt = points[points.length - 1];
          var totalDist = 0;
          for (var k = 1; k < points.length; k++) {
            totalDist += getHaversineDistance(points[k-1].lat, points[k-1].lng, points[k].lat, points[k].lng);
          }
          var distStr = formatDist(totalDist);
          var panelHtml = '<div class="measure-panel">';
          panelHtml += '<span class="dist">' + distStr + '</span>';
          if (mode) {
            panelHtml += '<button class="btn btn-finish" onclick="event.stopPropagation(); window.handleMeasureFinish()">完成</button>';
          }
          panelHtml += '<button class="btn btn-clear" onclick="event.stopPropagation(); window.handleMeasureClear()">清除</button>';
          panelHtml += '</div>';

          var panelMarker = new AMap.Marker({
            position: [lastPt.lng, lastPt.lat],
            offset: new AMap.Pixel(-80, -45),
            content: panelHtml
          });
          measureOverlayGroup.addOverlay(panelMarker);
        }
      };

      function getHaversineDistance(lat1, lon1, lat2, lon2) {
        var R = 6371000;
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLon = (lon2 - lon1) * Math.PI / 180;
        var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
      }

      window.updateSearchMarker = function(marker) {
        if (!map) return;
        if (searchMarkerObj) {
          if (searchMarkerObj.marker) {
            map.remove(searchMarkerObj.marker);
          } else {
            map.remove(searchMarkerObj);
          }
          if (searchMarkerObj.label) {
            map.remove(searchMarkerObj.label);
          }
          searchMarkerObj = null;
        }
        if (!marker) return;
        searchMarkerObj = {
          marker: new AMap.CircleMarker({
            center: [marker.lng, marker.lat],
            radius: 8,
            fillColor: '#E53935',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 2,
            zIndex: 100,
          }),
          label: new AMap.Marker({
            position: [marker.lng, marker.lat],
            offset: new AMap.Pixel(0, -22),
            content: '<div class="search-label">' + (marker.name || '搜索结果') + '</div>',
            clickable: false,
            zIndex: 101
          })
        };
        map.add(searchMarkerObj.marker);
        map.add(searchMarkerObj.label);
      };

      var satelliteLayer = null;
      var roadNetLayer = null;

      window.setMapType = function(type) {
        if (!map) return;
        try {
          if (type === 1) {
            if (!satelliteLayer) {
              satelliteLayer = new AMap.TileLayer.Satellite({ zIndex: 1 });
            }
            if (!roadNetLayer) {
              roadNetLayer = new AMap.TileLayer.RoadNet({ zIndex: 2 });
            }
            map.add(satelliteLayer);
            map.add(roadNetLayer);
            map.setFeatures(['road', 'building', 'point']);
          } else {
            if (satelliteLayer) {
              map.remove(satelliteLayer);
              satelliteLayer = null;
            }
            if (roadNetLayer) {
              map.remove(roadNetLayer);
              roadNetLayer = null;
            }
            map.setFeatures(['bg', 'road', 'building', 'point']);
          }
        } catch(e) {
          console.log('setMapType error:', e.message || e);
        }
      };

      window.moveCamera = function(lat, lng, zoom) {
        if (!map) return;
        _programmaticMove = true;
        map.setZoomAndCenter(zoom || 16, [lng, lat]);
      };

      // === 导航路线显示 ===
      var _routeArrowMarkers = [];
      var _currentRoutePolyline = null; // 保存当前路线，用于缩放时重新计算箭头
      var _routeGeneration = 0; // 路线代次计数，防止zoomend使用过期数据重绘箭头

      // 根据当前缩放级别重新计算并更新路线箭头
      // 箭头保持固定屏幕像素间距（约90px），不随zoom变化而改变视觉密度
      // expectedGeneration: 调用方传入的路线代次，与当前代次不匹配时跳过（防止过期zoomend重绘）
      function updateRouteArrows(polyline, expectedGeneration) {
        if (!map || !polyline || polyline.length < 2) return;
        // 代次校验：如果路线已被清除或替换，跳过此次重绘
        if (expectedGeneration !== undefined && expectedGeneration !== _routeGeneration) {
          log('updateRouteArrows: 代次不匹配(' + expectedGeneration + ' vs ' + _routeGeneration + ')，跳过');
          return;
        }
        for (var a = 0; a < _routeArrowMarkers.length; a++) {
          map.remove(_routeArrowMarkers[a]);
        }
        _routeArrowMarkers = [];
        var zoom = map.getZoom() || 15;
        var centerLat = (map.getCenter() || { lat: 23.7 }).lat;
        // 计算当前zoom下每像素代表的米数（基于Web墨卡托投影）
        // 公式: metersPerPixel = 156543.03392 * cos(lat) / 2^zoom
        var metersPerPixel = (156543.03392 * Math.cos(centerLat * Math.PI / 180)) / Math.pow(2, zoom);
        // 目标屏幕像素间距（约90px），转换为地理距离
        var targetPixelInterval = 90;
        var arrowInterval = Math.max(5, targetPixelInterval * metersPerPixel);
        var accumulatedDist = 0;
        var nextArrowDist = arrowInterval;
        // 重新绘制箭头
        for (var i = 0; i < polyline.length - 1; i++) {
          var p1 = polyline[i];
          var p2 = polyline[i + 1];
          var segDist = getHaversineDistance(p1[1], p1[0], p2[1], p2[0]);
          var bearing = getRouteBearing(p1, p2);
          while (accumulatedDist + segDist >= nextArrowDist) {
            var ratio = (nextArrowDist - accumulatedDist) / segDist;
            ratio = Math.min(1, Math.max(0, ratio));
            var arrowLng = p1[0] + (p2[0] - p1[0]) * ratio;
            var arrowLat = p1[1] + (p2[1] - p1[1]) * ratio;
            var arrowContent = '<div style="color:#fff;font-size:14px;font-weight:bold;' +
              'text-shadow:0 0 3px #007AFF,0 0 3px #007AFF,0 0 3px #007AFF;' +
              'transform:translate(-50%,-50%) rotate(' + (bearing - 90) + 'deg);">' + '>' + '</div>';
            var arrowMarker = new AMap.Marker({
              position: [arrowLng, arrowLat],
              content: arrowContent,
              offset: new AMap.Pixel(0, 0),
              clickable: false,
              zIndex: 85
            });
            map.add(arrowMarker);
            _routeArrowMarkers.push(arrowMarker);
            nextArrowDist += arrowInterval;
          }
          accumulatedDist += segDist;
        }
      }

      function getRouteBearing(p1, p2) {
        var lng1 = p1[0] * Math.PI / 180;
        var lat1 = p1[1] * Math.PI / 180;
        var lng2 = p2[0] * Math.PI / 180;
        var lat2 = p2[1] * Math.PI / 180;
        var dLng = lng2 - lng1;
        var y = Math.sin(dLng) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
        var bearing = Math.atan2(y, x) * 180 / Math.PI;
        return (bearing + 360) % 360;
      }

      window.addRoute = function(polyline) {
        if (!map || !routeOverlayGroup) return;
        routeOverlayGroup.clearOverlays();
        for (var a = 0; a < _routeArrowMarkers.length; a++) {
          map.remove(_routeArrowMarkers[a]);
        }
        _routeArrowMarkers = [];

        // 保存路线，用于缩放时重新计算箭头
        _currentRoutePolyline = polyline;
        _routeGeneration++; // 新路线，代次+1

        // polyline: [[lng, lat], ...] in GCJ-02
        var path = polyline.map(function(p) { return [p[0], p[1]]; });
        var routeLine = new AMap.Polyline({
          path: path,
          strokeColor: '#007AFF',
          strokeWeight: 8,
          strokeStyle: 'solid',
          lineJoin: 'round',
          lineCap: 'round',
          zIndex: 80
        });
        routeOverlayGroup.addOverlay(routeLine);

        // 不在此处绘制箭头！等待 fitRouteBounds 完成后的 zoomend 事件再绘制
        // 否则在错误的 zoom（如导航模式残留的 zoom=18）下会产生密集箭头

        // 确保路线在最上层
        routeOverlayGroup.setMap(map);
      };

      window.clearRoute = function() {
        if (routeOverlayGroup) {
          routeOverlayGroup.clearOverlays();
        }
        for (var i = 0; i < _routeArrowMarkers.length; i++) {
          map.remove(_routeArrowMarkers[i]);
        }
        _routeArrowMarkers = [];
        _currentRoutePolyline = null;
        _routeGeneration++; // 清除路线后代次+1，使旧的zoomend回调失效
        // 同时清除终点标记（防止残留）
        window.hideDestinationMarker();
        if (_autoFitTimer) { clearTimeout(_autoFitTimer); _autoFitTimer = null; }
      };

      // 目的地标记（带小区名称标签）
      var _destMarker = null;

      window.showDestinationMarker = function(lat, lng, name) {
        if (!map) return;
        if (_destMarker) {
          map.remove(_destMarker);
          if (_destMarker.label) {
            map.remove(_destMarker.label);
          }
          _destMarker = null;
        }
        var markerContent = '<div style="width:16px;height:16px;border-radius:50%;background:#E53935;' +
          'border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>';
        var marker = new AMap.CircleMarker({
          center: [lng, lat],
          radius: 8,
          fillColor: '#E53935',
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 2,
          zIndex: 110,
        });
        map.add(marker);

        var label = new AMap.Marker({
          position: [lng, lat],
          offset: new AMap.Pixel(0, -22),
          content: '<div class="marker-label">' + (name || '目的地') + '</div>',
          clickable: false,
          zIndex: 111
        });
        map.add(label);
        _destMarker = { marker: marker, label: label };
      };

      window.hideDestinationMarker = function() {
        if (_destMarker) {
          if (_destMarker.marker) {
            map.remove(_destMarker.marker);
          } else {
            map.remove(_destMarker);
          }
          if (_destMarker.label) {
            map.remove(_destMarker.label);
          }
          _destMarker = null;
        }
      };

      window.updateUserLocation = function(lat, lng, heading) {
        if (!map) return;
        _currentUserPos = [lat, lng]; // 存储当前位置用于 auto-fit
        var rot = (heading !== undefined && heading !== null) ? heading : 0;
        var arrowContent = '<div style="position:relative;width:30px;height:40px;">' +
          '<div style="position:absolute;top:0;left:0;width:30px;height:40px;' +
          'transition:transform 0.3s ease;' +
          'transform:rotate(' + rot + 'deg);transform-origin:15px 22px;">' +
          /* 三角箭头（位于圆上方） */
          '<div style="position:absolute;top:0;left:50%;margin-left:-7px;' +
          'width:0;height:0;' +
          'border-left:7px solid transparent;border-right:7px solid transparent;' +
          'border-bottom:12px solid #007AFF;"></div>' +
          /* 蓝色圆形主体 */
          '<div style="position:absolute;top:10px;left:3px;width:24px;height:24px;' +
          'background:#007AFF;border:3px solid #fff;border-radius:50%;' +
          'box-shadow:0 2px 8px rgba(0,0,0,0.35);">' +
          /* 中心白点 */
          '<div style="position:absolute;top:50%;left:50%;margin:-3px 0 0 -3px;' +
          'width:6px;height:6px;background:#fff;border-radius:50%;"></div>' +
          '</div>' +
          '</div>' +
          '</div>';
        if (!userLocationMarker) {
          var marker = new AMap.Marker({
            position: [lng, lat],
            content: arrowContent,
            offset: new AMap.Pixel(-15, -22),
            zIndex: 120,
          });
          map.add(marker);
          userLocationMarker = marker;
        } else {
          userLocationMarker.setPosition([lng, lat]);
          userLocationMarker.setContent(arrowContent);
        }
        // 实时跟随：如果 auto-fit 启用且用户没有手动操作，立即将地图中心移动到当前位置
        if (_autoFitEnabled && !_manualInteracting && !_programmaticMove) {
          _programmaticMove = true;
          map.setZoomAndCenter(_navDefaultZoom, [lng, lat]);
        }
      };

      window.clearUserLocation = function() {
        if (userLocationMarker) {
          map.remove(userLocationMarker);
          userLocationMarker = null;
        }
        _currentUserPos = null;
      };

      // Auto-fit
      function clearAutoFitTimer() {
        if (_autoFitTimer) {
          clearTimeout(_autoFitTimer);
          _autoFitTimer = null;
        }
      }
      function startAutoFitTimer() {
        if (!_autoFitEnabled) return;
        clearAutoFitTimer();
        _autoFitTimer = setTimeout(function() {
          if (_autoFitEnabled && _currentUserPos && map) {
            _programmaticMove = true;
            // 导航模式下固定使用 zoom=18，让用户看清近端路线细节
            map.setZoomAndCenter(_navDefaultZoom, [_currentUserPos[1], _currentUserPos[0]]);
            // 重置手动交互标志，恢复实时跟随
            _manualInteracting = false;
          }
          _autoFitTimer = null;
        }, 3000);
      }

      window.enableAutoFit = function() { _autoFitEnabled = true; };
      window.disableAutoFit = function() {
        _autoFitEnabled = false;
        clearAutoFitTimer();
      };
      // 更新导航剩余距离（供 auto-fit 动态 zoom 使用）
      window.setNavRemainingDistance = function(dist) {
        window._navRemainingDistance = dist;
      };

      // fitRouteBounds：展示路线全局视野
      // 将路线在"顶部工具栏下方 ~ 导航面板上方"的可见区域内居中显示
      window.fitRouteBounds = function(polyline, totalDistance, bottomPadding) {
        if (!map || !polyline || polyline.length === 0) return;
        _programmaticMove = true;
        // 计算路线点的最小/最大经纬度，构建 Bounds
        var minLng = polyline[0][0], maxLng = polyline[0][0];
        var minLat = polyline[0][1], maxLat = polyline[0][1];
        for (var i = 1; i < polyline.length; i++) {
          var p = polyline[i];
          if (p[0] < minLng) minLng = p[0];
          if (p[0] > maxLng) maxLng = p[0];
          if (p[1] < minLat) minLat = p[1];
          if (p[1] > maxLat) maxLat = p[1];
        }
        var sw = new AMap.LngLat(minLng, minLat);
        var ne = new AMap.LngLat(maxLng, maxLat);
        var bounds = new AMap.Bounds(sw, ne);
        // 根据路线距离动态调整缩放级别
        var targetZoom = 16;
        if (totalDistance) {
          if (totalDistance < 100) targetZoom = 19;
          else if (totalDistance < 200) targetZoom = 18;
          else if (totalDistance < 400) targetZoom = 17;
          else if (totalDistance < 800) targetZoom = 16;
          else if (totalDistance < 1500) targetZoom = 15;
          else if (totalDistance < 3000) targetZoom = 14;
          else if (totalDistance < 6000) targetZoom = 13;
          else targetZoom = 12;
        }
        // 获取地图容器尺寸，计算可用可视区域
        var container = map.getContainer();
        var mapHeight = container.offsetHeight || 700;
        var mapWidth = container.offsetWidth || 375;
        // 底部边距：导航面板高度 + 底部Tab栏 + 安全区（约占总高度的55%）
        // 顶部边距：搜索栏 + 工具栏 + 状态栏（约占总高度的18%）
        var extraBottom = bottomPadding || Math.round(mapHeight * 0.55);
        var extraTop = Math.round(mapHeight * 0.18);
        map.setBounds(bounds, targetZoom, false, [extraTop, 80, extraBottom, 80]);
      };

      // ==================== TAB 图层渲染 ====================
      var tabLayerGroups = {};  // { layerId: OverlayGroup }
      window.tabLayerGroups = tabLayerGroups;  // 供 injectJavaScript 全局访问

      window.removeTabLayer = function(layerId) {
        if (tabLayerGroups[layerId]) {
          map.remove(tabLayerGroups[layerId]);
          delete tabLayerGroups[layerId];
        }
      };

      function createGeoJSONOverlay(geometry, props, isGCJ02) {
        var type = geometry.type;
        var coordinates = geometry.coordinates;
        try {
          if (type === 'Point') {
            var lng = coordinates[0], lat = coordinates[1];
            if (!isGCJ02) { var g = wgs84ToGcj02(lat, lng); lat = g[0]; lng = g[1]; }
            var marker = new AMap.CircleMarker({
              center: [lng, lat],
              radius: 6,
              fillColor: '#ffffff',
              fillOpacity: 1,
              strokeColor: '#000000',
              strokeWeight: 2,
              extData: props
            });
            return marker;
          } else if (type === 'MultiPoint') {
            var mg = new AMap.OverlayGroup();
            for (var p = 0; p < coordinates.length; p++) {
              var lng2 = coordinates[p][0], lat2 = coordinates[p][1];
              if (!isGCJ02) { var g2 = wgs84ToGcj02(lat2, lng2); lat2 = g2[0]; lng2 = g2[1]; }
              mg.addOverlay(new AMap.CircleMarker({
                center: [lng2, lat2], radius: 6,
                fillColor: '#ffffff', fillOpacity: 1,
                strokeColor: '#000000', strokeWeight: 2
              }));
            }
            return mg;
          } else if (type === 'LineString') {
            var path = [];
            for (var k = 0; k < coordinates.length; k++) {
              var lng3 = coordinates[k][0], lat3 = coordinates[k][1];
              if (!isGCJ02) { var g3 = wgs84ToGcj02(lat3, lng3); lat3 = g3[0]; lng3 = g3[1]; }
              path.push([lng3, lat3]);
            }
            return new AMap.Polyline({ path: path, strokeColor: '#3b82f6', strokeWeight: 2, strokeOpacity: 0.8 });
          } else if (type === 'MultiLineString') {
            var mg2 = new AMap.OverlayGroup();
            for (var m = 0; m < coordinates.length; m++) {
              var linePath = [];
              for (var n = 0; n < coordinates[m].length; n++) {
                var lng4 = coordinates[m][n][0], lat4 = coordinates[m][n][1];
                if (!isGCJ02) { var g4 = wgs84ToGcj02(lat4, lng4); lat4 = g4[0]; lng4 = g4[1]; }
                linePath.push([lng4, lat4]);
              }
              mg2.addOverlay(new AMap.Polyline({ path: linePath, strokeColor: '#3b82f6', strokeWeight: 2, strokeOpacity: 0.8 }));
            }
            return mg2;
          } else if (type === 'Polygon') {
            var polyPath = [];
            var ring = coordinates[0];
            for (var r = 0; r < ring.length; r++) {
              var lng5 = ring[r][0], lat5 = ring[r][1];
              if (!isGCJ02) { var g5 = wgs84ToGcj02(lat5, lng5); lat5 = g5[0]; lng5 = g5[1]; }
              polyPath.push([lng5, lat5]);
            }
            return new AMap.Polygon({
              path: polyPath, fillColor: 'rgba(59,130,246,0.3)',
              fillOpacity: 0.5, strokeColor: '#3b82f6', strokeWeight: 2
            });
          } else if (type === 'MultiPolygon') {
            var mg3 = new AMap.OverlayGroup();
            for (var mp = 0; mp < coordinates.length; mp++) {
              var mpRing = coordinates[mp][0], mpPath = [];
              for (var mr = 0; mr < mpRing.length; mr++) {
                var lng6 = mpRing[mr][0], lat6 = mpRing[mr][1];
                if (!isGCJ02) { var g6 = wgs84ToGcj02(lat6, lng6); lat6 = g6[0]; lng6 = g6[1]; }
                mpPath.push([lng6, lat6]);
              }
              mg3.addOverlay(new AMap.Polygon({
                path: mpPath, fillColor: 'rgba(59,130,246,0.3)',
                fillOpacity: 0.5, strokeColor: '#3b82f6', strokeWeight: 2
              }));
            }
            return mg3;
          }
        } catch (e) {
          log('createGeoJSONOverlay error: ' + (e.message || e));
        }
        return null;
      }

      window.updateTabLayer = function(layerId, geojson) {
        window._updateTabLayerWithConv(layerId, geojson, false);
      };

      // 后端预处理版 - 坐标已为GCJ02
      window.updateTabLayerGCJ = function(layerId, geojson) {
        log('updateTabLayerGCJ called: layerId=' + layerId + ' hasFeatures=' + (geojson && geojson.features ? geojson.features.length : 0));
        window._updateTabLayerWithConv(layerId, geojson, true);
      };

      window._updateTabLayerWithConv = function(layerId, geojson, isGCJ02) {
        try {
          if (!map || !geojson) return;
          if (tabLayerGroups[layerId]) {
            map.remove(tabLayerGroups[layerId]);
          }
          if (!geojson.features || geojson.features.length === 0) return;
          var group = new AMap.OverlayGroup();
          var features = geojson.features;
          for (var i = 0; i < features.length; i++) {
            var feat = features[i];
            if (!feat.geometry || !feat.geometry.type) continue;
            var props = feat.properties || {};
            var overlay = createGeoJSONOverlay(feat.geometry, props, isGCJ02);
            if (overlay) group.addOverlay(overlay);
          }
          group.setMap(map);
          tabLayerGroups[layerId] = group;
          fitLayerBounds(group);
        } catch(e) { log('_updateTabLayerWithConv error: ' + (e.message || e)); }
      };

      // ==================== 地理化数据渲染 ====================
      var geoDataLayerGroups = {};  // { dataId: OverlayGroup }
      window.geoDataLayerGroups = geoDataLayerGroups;  // 供 injectJavaScript 全局访问

      window.updateGeoDataLayer = function(dataId, geometryType, data) {
        try {
          if (!map || !data) return;
          if (geoDataLayerGroups[dataId]) {
            map.remove(geoDataLayerGroups[dataId]);
          }
          if (data.length === 0) return;
          var group = new AMap.OverlayGroup();
          for (var i = 0; i < data.length; i++) {
            var item = data[i];
            var overlay = null;
            if (geometryType === 'sector') {
              overlay = createSectorOverlay(item);
            } else if (geometryType === 'polygon') {
              overlay = createPolygonOverlay(item);
            } else {
              overlay = createPointOverlay(item);
            }
            if (overlay) group.addOverlay(overlay);
          }
          group.setMap(map);
          geoDataLayerGroups[dataId] = group;
          fitLayerBounds(group);
        } catch(e) { log('updateGeoDataLayer error: ' + (e.message || e)); }
      };

      window.removeGeoDataLayer = function(dataId) {
        if (geoDataLayerGroups[dataId]) {
          map.remove(geoDataLayerGroups[dataId]);
          delete geoDataLayerGroups[dataId];
        }
      };

      function fitLayerBounds(group) {
        if (!map || !group) return;
        var overlays = group.getOverlays();
        if (overlays.length === 0) return;
        var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        var hasValid = false;
        function extendBounds(lng, lat) {
          if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            hasValid = true;
          }
        }
        for (var i = 0; i < overlays.length; i++) {
          try {
            var o = overlays[i];
            if (o.getPath) {
              var pts = o.getPath();
              for (var j = 0; j < pts.length; j++) {
                extendBounds(pts[j].getLng(), pts[j].getLat());
              }
            } else if (o.getCenter) {
              var c = o.getCenter();
              if (c) extendBounds(c.getLng(), c.getLat());
            }
          } catch(e) {}
        }
        if (hasValid) {
          var centerLat = (minLat + maxLat) / 2;
          var centerLng = (minLng + maxLng) / 2;
          var latSpan = maxLat - minLat;
          var lngSpan = maxLng - minLng;
          var zoom = 15;
          if (latSpan > 5 || lngSpan > 5) zoom = 5;
          else if (latSpan > 1 || lngSpan > 1) zoom = 8;
          else if (latSpan > 0.1 || lngSpan > 0.1) zoom = 12;
          else if (latSpan > 0.01 || lngSpan > 0.01) zoom = 14;
          map.setZoomAndCenter(zoom, [centerLng, centerLat], false);
        }
      }

      // ==================== 通过HTTP获取数据并渲染 ====================
      // 直接从后端API获取数据，避免桥接数据大小限制

      window.loadTabLayerFromAPI = function(apiUrl, dataId, layerId) {
        if (!map) return;
        var url = apiUrl + '/data/' + encodeURIComponent(dataId) + '/render-mobile';
        log('loadTabLayerFromAPI: fetching ' + url);
        fetch(url)
          .then(function(r) { return r.json(); })
          .then(function(resp) {
            log('loadTabLayerFromAPI: response success=' + resp.success);
            if (!resp.success || !resp.data || resp.data.dataType !== 'tab') {
              log('loadTabLayerFromAPI: invalid response');
              return;
            }
            var layers = resp.data.layers || [];
            log('loadTabLayerFromAPI: ' + layers.length + ' layers');
            var target = null;
            if (layerId) {
              for (var i = 0; i < layers.length; i++) {
                if (layers[i].id === layerId) { target = layers[i]; break; }
              }
            }
            if (!target && layers.length > 0) target = layers[0];
            if (!target) { log('loadTabLayerFromAPI: no layer found'); return; }
            log('loadTabLayerFromAPI: layer=' + target.name + ' features=' +
                (target.geojson && target.geojson.features ? target.geojson.features.length : 0));
            var layerKey = dataId + '_' + target.id;
            // 后端已经转换为 GCJ02，不需要再次转换
            window._updateTabLayerWithConv(layerKey, target.geojson, false);
          })
          .catch(function(err) { log('loadTabLayerFromAPI fetch error: ' + (err.message || err)); });
      };

      window.loadGeoDataFromAPI = function(apiUrl, dataId) {
        if (!map) return;
        var url = apiUrl + '/data/' + encodeURIComponent(dataId) + '/render-mobile';
        log('loadGeoDataFromAPI: fetching ' + url);
        fetch(url)
          .then(function(r) { return r.json(); })
          .then(function(resp) {
            log('loadGeoDataFromAPI: response success=' + resp.success);
            if (!resp.success || !resp.data || resp.data.dataType !== 'geo') {
              log('loadGeoDataFromAPI: invalid response');
              return;
            }
            var geometryType = resp.data.geometryType || 'point';
            var features = resp.data.features || [];
            log('loadGeoDataFromAPI: ' + features.length + ' features, type=' + geometryType);
            if (features.length > 0) {
              log('loadGeoDataFromAPI: first item keys=' + Object.keys(features[0]).join(','));
            }
            window.updateGeoDataLayer(dataId, geometryType, features);
          })
          .catch(function(err) { log('loadGeoDataFromAPI fetch error: ' + (err.message || err)); });
      };

      // 测试函数：在地图中心添加一个红色测试标记
      window.testInject = function() {
        if (!map) return;
        try {
          var center = map.getCenter();
          var marker = new AMap.CircleMarker({
            center: [center.lng, center.lat],
            radius: 20,
            fillColor: '#FF0000',
            fillOpacity: 0.8,
            strokeColor: '#fff',
            strokeWeight: 3
          });
          map.add(marker);
          log('testInject: marker added at ' + center.lng + ',' + center.lat);
        } catch(e) { log('testInject error: ' + e); }
      };

      // 全局错误捕获：将所有未捕获的错误报告给 React Native
      window.onerror = function(msg, url, line, col, err) {
        log('GLOBAL_ERROR: ' + msg + ' at ' + line + ':' + col);
      };

      log('TAB/GeoData layer rendering functions initialized');

      function createPointOverlay(item) {
        var lat = item.displayLat !== undefined ? item.displayLat : (item.latitude || 0);
        var lng = item.displayLng !== undefined ? item.displayLng : (item.longitude || 0);
        if (!lat || !lng) return null;
        // 如果坐标是 WGS84，需要转换
        var gcj;
        if (item.displayLat !== undefined) {
          gcj = [lat, lng]; // 已是 GCJ02
        } else {
          gcj = wgs84ToGcj02(lat, lng);
        }
        return new AMap.CircleMarker({
          center: [gcj[1], gcj[0]],
          radius: 8,
          fillColor: '#ffffff',
          fillOpacity: 1,
          strokeColor: '#000000',
          strokeWeight: 2
        });
      }

      function createSectorOverlay(item) {
        var lat = item.displayLat !== undefined ? item.displayLat : (item.latitude || 0);
        var lng = item.displayLng !== undefined ? item.displayLng : (item.longitude || 0);
        if (!lat || !lng) return null;
        var gcj;
        if (item.displayLat !== undefined) {
          gcj = [lat, lng];
        } else {
          gcj = wgs84ToGcj02(lat, lng);
        }
        var azimuth = item.azimuth || 0;
        var beamwidth = item.beamwidth || 65;
        var radius = item.cell_cover_type === 4 ? 30 : 80;
        var is360 = Math.abs(azimuth - 360) < 0.1;
        if (is360 || item.cell_cover_type === 4) {
          return new AMap.Circle({
            center: [gcj[1], gcj[0]],
            radius: radius,
            fillColor: '#ffffff',
            fillOpacity: 0.4,
            strokeColor: '#000000',
            strokeWeight: 2
          });
        }
        var path = calculateSectorPoints(gcj[0], gcj[1], azimuth, beamwidth, radius);
        return new AMap.Polygon({
          path: path,
          fillColor: '#ffffff',
          fillOpacity: 0.4,
          strokeColor: '#000000',
          strokeWeight: 2
        });
      }

      // Note: calculateSectorPoints is defined above at line 244, used for sector overlay rendering
      // and hit-testing. The second definition has been removed to avoid overwriting the correct version.

      function createPolygonOverlay(item) {
        if (!item.path || item.path.length < 3) return null;
        // path 格式: [lat, lng] in GCJ02
        var amapPath = [];
        for (var i = 0; i < item.path.length; i++) {
          amapPath.push([item.path[i][1], item.path[i][0]]);
        }
        return new AMap.Polygon({
          path: amapPath,
          fillColor: 'rgba(59,130,246,0.3)',
          fillOpacity: 0.5,
          strokeColor: '#3b82f6',
          strokeWeight: 2
        });
      }
    })();
  </script>
</body>
</html>
`;

export default forwardRef<MapViewRef, Props>(function MapView(props, ref) {
  const webViewRef = useRef<WebView>(null);
  const [mapReady, setMapReady] = useState(false);
  const prevCenterRef = useRef<string | null>(null);

  const {
    lteSectors,
    nrSectors,
    markers,
    measurePoints,
    measureMode,
    measureFinished,
    searchMarker,
    mapType,
    layers,
    setSelectedSector,
    selectedSector,
    focusLocation,
    setFocusLocation,
  } = useMapStore();
  const { onMapPress, onLongPress, onMarkerClick, onMeasureFinish, onMeasureClear, onSectorOverlap, onMapInteraction, onMapReady } = props;
  const showSatellite = props.showSatellite;

  const injectJS = useCallback((code: string) => {
    webViewRef.current?.injectJavaScript(code);
  }, []);

  // Inject all current data when map becomes ready
  const syncAllData = useCallback(() => {
    const visibleLte = layers.lte.visible ? lteSectors : [];
    const visibleNr = layers.nr.visible ? nrSectors : [];
    const allSectors = [...visibleLte, ...visibleNr];
    const searchMarkerJson = searchMarker ? JSON.stringify(searchMarker) : 'null';
    injectJS(`window.updateSectors(${JSON.stringify(allSectors)});`);
    injectJS(`window.updateMarkers(${JSON.stringify(markers)});`);
    injectJS(`window.updateMeasurePoints(${JSON.stringify(measurePoints)}, ${measureMode}, ${measureFinished});`);
    injectJS(`window.updateSearchMarker(${searchMarkerJson});`);
    if (showSatellite) {
      injectJS('window.setMapType(1);');
    }
    if (props.initialCenter) {
      injectJS(`window.moveCamera(${props.initialCenter[0]}, ${props.initialCenter[1]}, 16);`);
    }
  }, [lteSectors, nrSectors, markers, measurePoints, measureMode, measureFinished, searchMarker, showSatellite]);

  // Initial center - skip if coordinates haven't changed
  useEffect(() => {
    if (!mapReady) return;
    if (!props.initialCenter) {
      prevCenterRef.current = null;
      return;
    }
    const key = `${props.initialCenter[0]},${props.initialCenter[1]}`;
    if (prevCenterRef.current === key) return;
    prevCenterRef.current = key;
    injectJS(`window.moveCamera(${props.initialCenter[0]}, ${props.initialCenter[1]}, 16);`);
  }, [props.initialCenter, mapReady]);

  // Update sectors
  useEffect(() => {
    if (!mapReady) return;
    const visibleLte = layers.lte.visible ? lteSectors : [];
    const visibleNr = layers.nr.visible ? nrSectors : [];
    const allSectors = [...visibleLte, ...visibleNr];
    injectJS(`window.updateSectors(${JSON.stringify(allSectors)});`);
  }, [lteSectors, nrSectors, layers.lte.visible, layers.nr.visible, mapReady]);

  // Update markers
  useEffect(() => {
    if (!mapReady) return;
    injectJS(`window.updateMarkers(${JSON.stringify(markers)});`);
  }, [markers, mapReady]);

  // Update measure points
  useEffect(() => {
    if (!mapReady) return;
    injectJS(`window.updateMeasurePoints(${JSON.stringify(measurePoints)}, ${measureMode}, ${measureFinished});`);
  }, [measurePoints, measureMode, measureFinished, mapReady]);

  // Update search marker
  useEffect(() => {
    if (!mapReady) return;
    if (searchMarker) {
      injectJS(`window.updateSearchMarker(${JSON.stringify(searchMarker)});`);
    } else {
      injectJS('window.updateSearchMarker(null);');
    }
  }, [searchMarker, mapReady]);

  // Move camera when focusLocation changes (e.g. from favorites list)
  useEffect(() => {
    if (!mapReady || !focusLocation) return;
    injectJS(`window.moveCamera(${focusLocation.lat}, ${focusLocation.lng}, 16);`);
    // Clear focusLocation after moving to prevent re-triggering
    setFocusLocation(null);
  }, [focusLocation, mapReady, setFocusLocation]);

  // Update map type
  useEffect(() => {
    if (!mapReady) return;
    injectJS(`window.setMapType(${showSatellite ? 1 : 0});`);
  }, [showSatellite, mapReady]);

  // Sector selection highlight (direct overlay manipulation, no full re-render)
  useEffect(() => {
    if (!mapReady) return;
    const id = selectedSector?.id;
    if (id) {
      injectJS(`window.selectSector('${id}');`);
    } else {
      injectJS('window.deselectSector();');
    }
  }, [selectedSector, mapReady]);

  // Handle messages from WebView
  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      switch (data.type) {
        case 'mapReady':
          setMapReady(true);
          syncAllData();
          onMapReady?.();
          break;
        case 'mapClick':
          console.log('[MapView] mapClick:', data.lat, data.lng);
          onMapPress?.(data.lat, data.lng);
          resetNavUiAutoHide();
          break;
        case 'mapLongPress':
          onLongPress?.(data.lat, data.lng);
          resetNavUiAutoHide();
          break;
        case 'markerClick':
          if (data.marker) {
            onMarkerClick?.(data.marker);
          }
          resetNavUiAutoHide();
          break;
        case 'sectorClick':
          console.log('[MapView] sectorClick:', data.sector?.id, data.sector?.name, 'lat:', data.sector?.latitude, 'lng:', data.sector?.longitude);
          setSelectedSector(data.sector);
          resetNavUiAutoHide();
          break;
        case 'sectorOverlap':
          onSectorOverlap?.(data.sectors, data.lat, data.lng);
          resetNavUiAutoHide();
          break;
        case 'log':
          console.log('[MapView Web]', data.message);
          // 全局错误以 GLOBAL_ERROR 开头，打印到控制台
          if (data.message && data.message.indexOf('GLOBAL_ERROR') >= 0) {
            console.error('[MapView Web ERROR]', data.message);
          }
          break;
        case 'renderError':
          console.error('[MapView Render ERROR]', data.message);
          break;
        case 'measureClear':
          onMeasureClear?.();
          break;
        case 'measureFinish':
          onMeasureFinish?.();
          break;
        case 'mapInteraction':
          onMapInteraction?.();
          resetNavUiAutoHide();
          break;
      }
    } catch (err) {
      console.error('[MapView] message error:', err);
    }
  }, [onMapPress, onLongPress, onMarkerClick, onMeasureFinish, onMeasureClear, onSectorOverlap, setSelectedSector, syncAllData]);

  useImperativeHandle(ref, () => ({
    moveCamera: (lat: number, lng: number, zoom?: number) => {
      injectJS(`window.moveCamera(${lat}, ${lng}, ${zoom || 16});`);
    },
    addRoute: (polyline: [number, number][]) => {
      injectJS(`window.addRoute(${JSON.stringify(polyline)});`);
    },
    clearRoute: () => {
      injectJS('window.clearRoute();');
    },
    showDestinationMarker: (lat: number, lng: number, name: string) => {
      injectJS(`window.showDestinationMarker(${lat}, ${lng}, ${JSON.stringify(name)});`);
    },
    hideDestinationMarker: () => {
      injectJS('window.hideDestinationMarker();');
    },
    updateUserLocation: (lat: number, lng: number, heading?: number) => {
      injectJS(`window.updateUserLocation(${lat}, ${lng}, ${heading || 0});`);
    },
    clearUserLocation: () => {
      injectJS('window.clearUserLocation();');
    },
    fitRouteBounds: (polyline: [number, number][], totalDistance?: number) => {
      injectJS(`window.fitRouteBounds(${JSON.stringify(polyline)}, ${totalDistance || 0});`);
    },
    locateMe: (lat: number, lng: number, zoom?: number) => {
      injectJS(`window.moveCamera(${lat}, ${lng}, ${zoom || 16});`);
      injectJS(`window.updateUserLocation(${lat}, ${lng}, 0);`);
    },
    startAutoFit: () => {
      injectJS('window.enableAutoFit();');
    },
    stopAutoFit: () => {
      injectJS('window.disableAutoFit();');
    },
    setNavRemainingDistance: (dist: number) => {
      injectJS(`window.setNavRemainingDistance(${dist});`);
    },
    injectJavaScript: (script: string) => {
      injectJS(script);
    },
  }));

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ html: HTML_TEMPLATE }}
        style={styles.map}
        onMessage={handleMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        geolocationEnabled={true}
        startInLoadingState={true}
        allowFileAccess={true}
        mixedContentMode="compatibility"
        originWhitelist={['*']}
      />
      {!mapReady && (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>地图加载中...</Text>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
  },
  loadingText: {
    marginTop: 8,
    color: '#666',
    fontSize: 14,
  },
});
