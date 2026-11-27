/** 图片标注：双指缩放、画圈/尖头箭头/文字、撤销重做、颜色选择、就地文字输入。 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, Modal, TouchableOpacity, ActivityIndicator, Alert, StyleSheet,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { WebView } from 'react-native-webview';

import { imApi } from '../../services/imApi';
import { resolveImageUri } from '../../services/imAttachment';
import type { ImMessage } from '../../types/im';
import type { ImColors } from './colors';

const EDITOR_HTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;height:100%;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}
#viewport{transform-origin:center center}
canvas{display:block;max-width:100%;max-height:100%;width:auto;height:auto;touch-action:none}</style></head>
<body><div id="viewport"><canvas id="c"></canvas></div><script>
const viewport=document.getElementById('viewport'),canvas=document.getElementById('c'),ctx=canvas.getContext('2d');
const img=new Image();
img.onload=()=>{canvas.width=img.width;canvas.height=img.height;ctx.drawImage(img,0,0);pushHistory();};
img.src="__IMAGE__";
const snap=document.createElement('canvas'),snapCtx=snap.getContext('2d');
let scale=1,startScale=1,startDist=0,pinching=false,drawing=false,last=null,arrowStart=null,tapStart=null;
let tool='pen',color='#FF3B30',history=[],historyIndex=-1;
function setTool(t){tool=t;}
function setColor(c){color=c;}
function pushHistory(){history=history.slice(0,historyIndex+1);history.push(ctx.getImageData(0,0,canvas.width,canvas.height));historyIndex=history.length-1;}
function undo(){if(historyIndex<=0)return;historyIndex--;ctx.putImageData(history[historyIndex],0,0);}
function redo(){if(historyIndex>=history.length-1)return;historyIndex++;ctx.putImageData(history[historyIndex],0,0);}
function applyScale(){viewport.style.transform='scale('+scale+')';}
function dist(t){return Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);}
function point(e){const r=canvas.getBoundingClientRect(),t=e.touches[0];const rawX=(t.clientX-r.left)*canvas.width/r.width,rawY=(t.clientY-r.top)*canvas.height/r.height;return{x:Math.max(0,Math.min(canvas.width,rawX)),y:Math.max(0,Math.min(canvas.height,rawY))};}
function drawArrow(a,b){
 const angle=Math.atan2(b.y-a.y,b.x-a.x),head=Math.max(18,canvas.width/48);
 ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=Math.max(4,canvas.width/180);ctx.lineCap='butt';
 const endX=b.x-head*0.7*Math.cos(angle),endY=b.y-head*0.7*Math.sin(angle);
 ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(endX,endY);ctx.stroke();
 ctx.beginPath();ctx.moveTo(b.x,b.y);
 ctx.lineTo(b.x-head*Math.cos(angle-0.45),b.y-head*Math.sin(angle-0.45));
 ctx.lineTo(b.x-head*Math.cos(angle+0.45),b.y-head*Math.sin(angle+0.45));
 ctx.closePath();ctx.fill();
}
function drawShape(a,b){
 const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y);
 ctx.strokeStyle=color;ctx.lineWidth=Math.max(4,canvas.width/180);ctx.lineJoin='round';
 if(tool==='rect'){ctx.strokeRect(x,y,w,h);}
 else{ctx.beginPath();ctx.ellipse(x+w/2,y+h/2,Math.max(1,w/2),Math.max(1,h/2),0,0,Math.PI*2);ctx.stroke();}
}
document.addEventListener('touchstart',e=>{
 if(e.touches.length>=2){pinching=true;drawing=false;tapStart=null;startDist=dist(e.touches);startScale=scale;return;}
 if(pinching)return;
 if(tool==='text'){tapStart={clientX:e.touches[0].clientX,clientY:e.touches[0].clientY};return;}
 e.preventDefault();drawing=true;last=point(e);
 if(tool==='arrow'||tool==='rect'||tool==='circle'){
  pushHistory();arrowStart=last;
  snap.width=canvas.width;snap.height=canvas.height;snapCtx.drawImage(canvas,0,0);
 }else{pushHistory();ctx.beginPath();ctx.moveTo(last.x,last.y);}
});
document.addEventListener('touchmove',e=>{
 if(e.touches.length>=2){if(!pinching)return;e.preventDefault();scale=Math.max(1,Math.min(4,startScale*dist(e.touches)/startDist));applyScale();return;}
 if(pinching)return;
 if(drawing){
  e.preventDefault();const p=point(e);
  if(tool==='arrow'){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(snap,0,0);drawArrow(arrowStart,p);}
  else if(tool==='rect'||tool==='circle'){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(snap,0,0);drawShape(arrowStart,p);}
  else{ctx.strokeStyle=color;ctx.lineWidth=Math.max(4,canvas.width/150);ctx.lineCap='round';ctx.lineJoin='round';ctx.quadraticCurveTo(last.x,last.y,(last.x+p.x)/2,(last.y+p.y)/2);ctx.stroke();}
  last=p;
 }
});
document.addEventListener('touchend',e=>{
 if(e.touches.length<2)pinching=false;
 if(tool==='text'&&tapStart&&e.changedTouches.length){
  const t=e.changedTouches[0];
  if(Math.abs(t.clientX-tapStart.clientX)<12&&Math.abs(t.clientY-tapStart.clientY)<12){
   const p=point({touches:[t]});
   window.ReactNativeWebView.postMessage(JSON.stringify({type:'placeText',x:p.x,y:p.y,clientX:t.clientX,clientY:t.clientY}));
  }
 }
 if((tool==='arrow'||tool==='rect'||tool==='circle')&&drawing&&e.changedTouches.length){
  const p=point({touches:[e.changedTouches[0]]});
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(snap,0,0);
  if(tool==='arrow') drawArrow(arrowStart,p); else drawShape(arrowStart,p);
 }
 if(tool==='pen'&&drawing&&e.changedTouches.length){
  const p=point({touches:[e.changedTouches[0]]});
  ctx.lineTo(p.x,p.y);ctx.stroke();
 }
 tapStart=null;drawing=false;
});
let textSnapshot=null,textPos=null;
function beginText(x,y){if(!canvas.width)return;pushHistory();textSnapshot=document.createElement('canvas');textSnapshot.width=canvas.width;textSnapshot.height=canvas.height;textSnapshot.getContext('2d').drawImage(canvas,0,0);textPos={x:x,y:y};}
function renderPendingText(text){if(!textPos||!textSnapshot)return;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(textSnapshot,0,0);if(!text)return;ctx.fillStyle=color;ctx.strokeStyle='#FFFFFF';ctx.lineWidth=2;ctx.font='bold '+(canvas.width/20)+'px sans-serif';ctx.textBaseline='top';ctx.strokeText(text,textPos.x,textPos.y);ctx.fillText(text,textPos.x,textPos.y);}
function finishText(){textPos=null;textSnapshot=null;}
function exportImage(){window.ReactNativeWebView.postMessage(canvas.toDataURL('image/jpeg',0.85).split(',')[1]);}
</script></body></html>`;

const PALETTE = ['#FF3B30', '#007AFF', '#34C759', '#FFCC00', '#FFFFFF', '#000000'];
const HTML_VERSION = 'v7';
type EditorTool = 'pen' | 'arrow' | 'rect' | 'circle' | 'text';

interface Props {
  message: ImMessage
  colors: ImColors
  onClose: () => void
}

export default function ImageEditor({ message, colors, onClose }: Props) {
  const webviewRef = useRef<WebView>(null);
  const textInputRef = useRef<TextInput>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [tool, setTool] = useState<EditorTool>('pen');
  const [color, setColor] = useState(PALETTE[0]);
  const [textPosition, setTextPosition] = useState<{ x: number; y: number } | null>(null);
  const [textScreenPos, setTextScreenPos] = useState<{ x: number; y: number } | null>(null);
  const [pendingText, setPendingText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const id = message.attachment?.id;
        if (!id) throw new Error('图片附件不存在');
        const dir = `${FileSystem.cacheDirectory}im/`;
        const info = await FileSystem.getInfoAsync(dir);
        if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

        const htmlPath = `${dir}editor-${id}-${HTML_VERSION}.html`;
        const htmlInfo = await FileSystem.getInfoAsync(htmlPath);
        let htmlText: string;
        if (htmlInfo.exists) {
          htmlText = await FileSystem.readAsStringAsync(htmlPath);
        } else {
          const sourcePath = `${dir}edit-source-${id}.jpg`;
          const sourceInfo = await FileSystem.getInfoAsync(sourcePath);
          if (!sourceInfo.exists) {
            const signed = await imApi.signedImageUrl(id, false);
            if (signed) await FileSystem.downloadAsync(signed, sourcePath);
            else {
              const resolved = await resolveImageUri(id, false);
              if (resolved !== sourcePath) await FileSystem.copyAsync({ from: resolved, to: sourcePath });
            }
          }
          const base64 = await FileSystem.readAsStringAsync(sourcePath, {
            encoding: FileSystem.EncodingType.Base64,
          });
          const rawMime = (message.attachment?.mime || '').toLowerCase();
          const mime = ['image/png', 'image/jpeg', 'image/webp'].includes(rawMime) ? rawMime : 'image/jpeg';
          htmlText = EDITOR_HTML.replace('__IMAGE__', `data:${mime};base64,${base64}`);
          await FileSystem.writeAsStringAsync(htmlPath, htmlText);
        }
        if (active) setHtml(htmlText);
      } catch (e) {
        if (active) Alert.alert('提示', e instanceof Error ? e.message : '图片加载失败');
      }
    })();
    return () => { active = false; };
  }, [message.attachment?.id, message.attachment?.mime]);

  const clearPending = () => {
    setPendingText('');
    setTextPosition(null);
    setTextScreenPos(null);
  };

  // 文字在每个字符输入时已实时画到图片上，这里只需结束本次输入状态
  const commitPendingText = () => {
    webviewRef.current?.injectJavaScript('finishText();');
    clearPending();
  };

  const selectTool = (next: EditorTool) => {
    commitPendingText();
    setTool(next);
    webviewRef.current?.injectJavaScript(`setTool('${next}');`);
  };

  const selectColor = (next: string) => {
    setColor(next);
    webviewRef.current?.injectJavaScript(
      `setColor(${JSON.stringify(next)});renderPendingText(${JSON.stringify(pendingText)});`,
    );
  };

  const submitText = () => {
    commitPendingText();
    textInputRef.current?.blur();
  };

  const exportEdited = () => {
    webviewRef.current?.injectJavaScript('finishText();exportImage();');
    clearPending();
  };

  const save = async (data: string) => {
    setSaving(true);
    try {
      const target = `${FileSystem.cacheDirectory}im/edited-${Date.now()}.jpg`;
      await FileSystem.writeAsStringAsync(target, data, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备不支持分享图片');
      await Sharing.shareAsync(target, { dialogTitle: '编辑后的图片' });
      onClose();
    } catch (e) {
      Alert.alert('提示', e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleMessage = (data: string) => {
    try {
      const payload = JSON.parse(data);
      if (payload?.type === 'placeText' && typeof payload.x === 'number') {
        // 结束上一段并在新坐标开始：文字从光标位置实时绘制，所见即所得
        webviewRef.current?.injectJavaScript(`finishText();beginText(${payload.x},${payload.y});`);
        clearPending();
        setTextPosition({ x: payload.x, y: payload.y });
        setTextScreenPos({ x: payload.clientX || 24, y: payload.clientY || 120 });
        textInputRef.current?.focus();
        return;
      }
    } catch { /* 导出结果是纯 base64 */ }
    void save(data);
  };

  const tools: Array<{ key: EditorTool; icon: string }> = [
    { key: 'pen', icon: '✎' },
    { key: 'arrow', icon: '↗' },
    { key: 'rect', icon: '▭' },
    { key: 'circle', icon: '○' },
    { key: 'text', icon: 'T' },
  ];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={[styles.container, { backgroundColor: colors.overlayBg }]}>
      <View style={[styles.header, { backgroundColor: colors.card }]}>
        <TouchableOpacity onPress={onClose}>
          <Text style={[styles.headerBtn, { color: colors.textMuted }]}>取消</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.textPrimary }]}>编辑图片</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity
            onPress={() => { commitPendingText(); webviewRef.current?.injectJavaScript('undo();'); }}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          >
            <Text style={[styles.headerIcon, { color: colors.textPrimary }]}>↶</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { commitPendingText(); webviewRef.current?.injectJavaScript('redo();'); }}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          >
            <Text style={[styles.headerIcon, { color: colors.textPrimary }]}>↷</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={exportEdited} disabled={saving}>
            {saving
              ? <ActivityIndicator color={colors.accent} size="small" />
              : <Text style={[styles.headerBtn, { color: colors.accent }]}>完成</Text>}
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.stage}>
        {html ? (
          <WebView
            ref={webviewRef}
            source={{ html }}
            style={styles.webview}
            javaScriptEnabled
            domStorageEnabled
            mixedContentMode="always"
            onMessage={(event) => handleMessage(event.nativeEvent.data)}
          />
        ) : (
          <ActivityIndicator color="#FFFFFF" size="large" />
        )}
        {/* 相对 WebView 容器定位：clientX/clientY 与光标位置一致，不受 header 偏移影响 */}
        <TextInput
          ref={textInputRef}
          style={[
            styles.inlineInput,
            {
              left: textScreenPos?.x ?? 0,
              top: textScreenPos?.y ?? 0,
              color: 'transparent',
              tintColor: color,
            } as any,
          ]}
          value={pendingText}
          onChangeText={(text) => {
            setPendingText(text);
            webviewRef.current?.injectJavaScript(`renderPendingText(${JSON.stringify(text)});`);
          }}
          onSubmitEditing={submitText}
          returnKeyType="done"
          blurOnSubmit
        />
      </View>

      <View style={[styles.colorBar, { backgroundColor: colors.card }]}>
        {PALETTE.map((item) => (
          <TouchableOpacity
            key={item}
            style={[
              styles.colorDot,
              { backgroundColor: item, borderColor: color === item ? colors.textPrimary : 'transparent' },
            ]}
            onPress={() => selectColor(item)}
          />
        ))}
      </View>

      <View style={[styles.toolBar, { backgroundColor: colors.card }]}>
        {tools.map((item) => (
          <TouchableOpacity
            key={item.key}
            style={[styles.toolBtn, { backgroundColor: tool === item.key ? colors.accent : colors.inputBg }]}
            onPress={() => selectTool(item.key)}
          >
            <Text style={[styles.toolIcon, { color: tool === item.key ? '#FFFFFF' : colors.textSecondary }]}>
              {item.icon}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

    </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  headerBtn: { fontSize: 15 },
  headerIcon: { fontSize: 22, lineHeight: 24, marginRight: 10 },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 16, fontWeight: '600' },
  stage: { flex: 1, justifyContent: 'center' },
  webview: { flex: 1, backgroundColor: '#000000' },
  colorBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingTop: 12 },
  colorDot: { width: 24, height: 24, borderRadius: 12, borderWidth: 2 },
  toolBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 14 },
  toolBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  toolIcon: { fontSize: 22, fontWeight: '600' },
  inlineInput: {
    position: 'absolute', width: 160, height: 32,
    backgroundColor: 'transparent', fontSize: 16, fontWeight: 'bold',
    padding: 0, borderWidth: 0,
  },
});
