#!/usr/bin/env python3
"""她的发音调音台：在浏览器里改参数、直接听（2026-10-14）。

为什么自己做一个而不是用 RVC 自带的 WebUI：那台机器上两套引擎共用一份 Python 环境，
RVC 的 gradio 和 F5 要的 huggingface_hub/numpy 互相打架（`HfFolder` 被删、`gr.Audio(source=)`
在 4.44/4.26 都没了），修下去是无底洞。管理员要的是"能听、能调"，那就直接给他一个。

它挂在常驻合成服务上（`scripts/speak-server.py`，同一个 3111 端口）：
  GET  /        → 这个调音台
  POST /speak   → {"text","calm","over":{pitch,eq,semitones,index_rate,protect}}
  GET  /health  → 服务状态

链路：文字 → F5 生成底音（保咬字）→ RVC 换音色（他的模型）→ 变调/压高频 → 语音条。
"""

PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>她的发音调音台</title>
<style>
 body{font:15px/1.6 system-ui,"Segoe UI",sans-serif;max-width:820px;margin:28px auto;padding:0 18px;color:#222}
 h1{font-size:20px;margin:0 0 4px} .sub{color:#777;font-size:13px;margin-bottom:18px}
 textarea{width:100%;box-sizing:border-box;height:64px;padding:8px;font:15px/1.5 inherit;border:1px solid #ccc;border-radius:6px}
 .row{display:flex;align-items:center;gap:12px;margin:9px 0}
 .row label{width:190px;font-size:14px;color:#333}
 .row input[type=range]{flex:1} .val{width:66px;text-align:right;font-variant-numeric:tabular-nums;color:#0a6}
 button{margin-top:14px;padding:10px 22px;font-size:15px;border:0;border-radius:6px;background:#0a6;color:#fff;cursor:pointer}
 button:disabled{background:#aaa;cursor:default}
 audio{width:100%;margin-top:16px} .log{margin-top:14px;font-size:13px;color:#555;white-space:pre-wrap}
 .tips{margin-top:22px;padding:12px 14px;background:#f6f8f9;border-radius:6px;font-size:13px;color:#555}
 code{background:#eee;padding:1px 4px;border-radius:3px}
</style></head><body>
<h1>她的发音调音台</h1>
<div class="sub">改完参数点生成，直接听。参数是全局的（下次调用还用这套），调好告诉我，我固化进服务。</div>

<textarea id="text">你终于来了。我还以为你今天不来了，有点担心。</textarea>

<div class="row"><label>变调（外挂，×倍率）</label><input type="range" id="pitch" min="0.80" max="1.20" step="0.01" value="1.00"><span class="val" id="pitch_v"></span></div>
<div class="row"><label>RVC 半音（内建）</label><input type="range" id="semitones" min="-6" max="6" step="1" value="0"><span class="val" id="semitones_v"></span></div>
<div class="row"><label>高频衰减（dB，压"中性"）</label><input type="range" id="eq" min="-16" max="0" step="1" value="-9"><span class="val" id="eq_v"></span></div>
<div class="row"><label>索引率（像不像）</label><input type="range" id="index_rate" min="0" max="1" step="0.05" value="0.75"><span class="val" id="index_rate_v"></span></div>
<div class="row"><label>protect（护清音）</label><input type="range" id="protect" min="0" max="0.5" step="0.01" value="0.33"><span class="val" id="protect_v"></span></div>

<button id="go">生成并试听</button>
<audio id="au" controls></audio>
<div class="log" id="log"></div>

<div class="tips">
 <b>参考数值</b>（她本人的声学特征：基频 <b>187.8Hz</b>、频谱质心 <b>1373Hz</b>）：<br>
 · F5 旧引擎：基频 258Hz、质心 2598Hz —— 又高又亮，所以听着"中性"<br>
 · 他的 RVC 模型裸用：基频 210Hz、质心 1663Hz<br>
 · 目前最好的一次：基频 209.8Hz、质心 1592Hz（<code>eq=-9</code>）<br>
 <b>方向</b>：<code>eq</code> 越负质心越低（越不"薄"）；<code>pitch</code> 和 <code>semitones</code> 都用来调基频，
 但实测 RVC 内建 <code>semitones</code> 非 0 时行为不可靠（两个方向都抬），优先用 <code>pitch</code>。
</div>

<script>
const ids=['pitch','semitones','eq','index_rate','protect'];
const show=()=>ids.forEach(i=>document.getElementById(i+'_v').textContent=document.getElementById(i).value);
ids.forEach(i=>document.getElementById(i).addEventListener('input',show)); show();
document.getElementById('go').onclick=async()=>{
  const b=document.getElementById('go'), log=document.getElementById('log');
  b.disabled=true; log.textContent='生成中…（要 10~25 秒）';
  const over={}; ids.forEach(i=>over[i]=parseFloat(document.getElementById(i).value));
  try{
    const r=await fetch('/speak',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({text:document.getElementById('text').value,over})});
    const j=await r.json();
    if(!j.ok){log.textContent='失败：'+(j.error||'未知');b.disabled=false;return}
    document.getElementById('au').src='/audio/'+encodeURIComponent(j.wav.split(/[\\\\/]/).pop())+'?t='+Date.now();
    log.textContent='✓ '+j.seconds+'s 音频，合成 '+(j.ms/1000).toFixed(1)+'s\\n参数：'+JSON.stringify(over);
  }catch(e){log.textContent='请求失败：'+e}
  b.disabled=false;
};
</script></body></html>
"""
