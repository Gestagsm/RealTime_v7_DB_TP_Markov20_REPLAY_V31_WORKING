(function(){
  'use strict';
  if(window.__ORDERFLOW_MANUAL_AUTOSAVE__) return;
  window.__ORDERFLOW_MANUAL_AUTOSAVE__=true;
  var running=false,capture=null,requestSeq=0,pendingWrites={},localDirectory=null;
  var originalAnchorClick=HTMLAnchorElement.prototype.click;

  function setLocalStatus(text,bad){
    var local=document.getElementById('sum-save-both-status');
    if(local){local.textContent=text||'';local.style.color=bad?'#ff6b6b':'#79d99b';}
  }
  function setStatus(text,bad){
    setLocalStatus(text,bad);
    try{window.parent.postMessage({type:'of-autosave-child-status',text:text||'',bad:!!bad},'*');}catch(e){}
  }
  function exactArrayBuffer(value){
    if(value instanceof ArrayBuffer)return value;
    if(ArrayBuffer.isView(value))return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);
    return new Uint8Array(value).buffer;
  }
  function saveThroughMainPage(kind,filename,buffer){
    if(localDirectory){
      return (async function(){
        var safe=String(filename||'export.xlsx').replace(/[\\/:*?"<>|]/g,'-');
        var handle=await localDirectory.getFileHandle(safe,{create:true});
        var writable=await handle.createWritable();
        await writable.write(exactArrayBuffer(buffer));
        await writable.close();
        return localDirectory.name+'\\'+safe;
      })();
    }
    return new Promise(function(resolve,reject){
      var id='of-'+Date.now()+'-'+(++requestSeq);
      var timer=setTimeout(function(){delete pendingWrites[id];reject(new Error('Folder save timed out.'));},300000);
      pendingWrites[id]={
        resolve:function(path){clearTimeout(timer);resolve(path);},
        reject:function(err){clearTimeout(timer);reject(err);}
      };
      try{
        var exact=exactArrayBuffer(buffer);
        window.parent.postMessage({
          type:'of-autosave-write',requestId:id,kind:kind,filename:filename,buffer:exact
        },'*',[exact]);
      }catch(err){clearTimeout(timer);delete pendingWrites[id];reject(err);}
    });
  }
  window.ofAutosaveBuffer=function(kind,filename,buffer){
    if(!capture||capture.kind!==kind)return false;
    var current=capture;capture=null;
    saveThroughMainPage(kind,filename,buffer).then(current.resolve,current.reject);
    return true;
  };
  HTMLAnchorElement.prototype.click=function(){
    if(!capture)return originalAnchorClick.apply(this,arguments);
    var current=capture;capture=null;
    var href=this.href,filename=this.download||(current.kind+'.xlsx');
    fetch(href).then(function(r){return r.arrayBuffer();})
      .then(function(buf){return saveThroughMainPage(current.kind,filename,buf);})
      .then(current.resolve,current.reject);
  };
  function exportOne(kind,fn){
    return new Promise(function(resolve,reject){
      var timeout=setTimeout(function(){
        if(capture&&capture.kind===kind)capture=null;
        reject(new Error(kind+' export did not finish'));
      },300000);
      capture={
        kind:kind,
        resolve:function(path){clearTimeout(timeout);resolve(path);},
        reject:function(err){clearTimeout(timeout);reject(err);}
      };
      var oldConfirm=window.confirm;
      try{window.confirm=function(){return true;};fn();}
      catch(err){capture=null;clearTimeout(timeout);reject(err);}
      finally{window.confirm=oldConfirm;}
    });
  }
  async function runAutosave(){
    if(running)return;
    if(typeof window.sumSaveHistoryToExcel!=='function'||typeof window.sumSaveSummaryToExcel!=='function'){
      throw new Error('Save History or Save Summary is not ready');
    }
    running=true;
    try{
      setStatus('Saving PH…');
      await exportOne('history',window.sumSaveHistoryToExcel);
      setStatus('Saving Price_Summary…');
      await exportOne('summary',window.sumSaveSummaryToExcel);
      if(typeof window.sumSaveTPResults==='function'){
        setStatus('Saving TP Results…');
        await exportOne('tp',window.sumSaveTPResults);
        setStatus('✓ PH + Price_Summary + TP Results saved');
      }else{
        setStatus('✓ PH + Price_Summary saved');
      }
    }catch(err){
      console.error('[manual autosave]',err);
      setStatus('⚠ '+(err&&err.message?err.message:err),true);
    }finally{running=false;}
  }
  async function chooseLocalFolderAndSave(){
    try{
      if(typeof window.showDirectoryPicker!=='function')throw new Error('Use Microsoft Edge or Google Chrome');
      setLocalStatus('Select folder…',false);
      localDirectory=await window.showDirectoryPicker({mode:'readwrite'});
      await runAutosave();
    }catch(err){
      var cancelled=err&&err.name==='AbortError';
      setStatus(cancelled?'Selection cancelled':'⚠ '+(err&&err.message?err.message:err),!cancelled);
    }finally{localDirectory=null;}
  }
  function ensureLocalButton(){
    var summary=document.getElementById('sum-save-summary-btn');
    if(!summary)return;
    var btn=document.getElementById('sum-save-both-btn');
    if(!btn){
      btn=document.createElement('button');
      btn.id='sum-save-both-btn';btn.type='button';
      btn.textContent='Save History + Summary';
      btn.title='Choose any folder and save both PH and Price_Summary into it';
      btn.style.cssText='border:1px solid #218a63;background:#0d2b22;color:#69e6b2;border-radius:5px;padding:5px 9px;cursor:pointer;font-size:11px;white-space:nowrap';
      btn.onclick=function(){
        setLocalStatus('Select folder…',false);
        // showDirectoryPicker is forbidden inside an embedded frame. Ask the
        // top-level Command Center through postMessage; do not read parent
        // properties, which is also blocked for file/cross-origin frames.
        if(window.top!==window){
          window.parent.postMessage({type:'of-request-save-both'},'*');
        }else{
          chooseLocalFolderAndSave();
        }
      };
      summary.parentNode.insertBefore(btn,summary.nextSibling);
    }
    var status=document.getElementById('sum-save-both-status');
    if(!status){
      status=document.createElement('span');status.id='sum-save-both-status';
      status.style.cssText='font-size:10px;color:#8290a8;margin-left:4px;white-space:nowrap';
      btn.parentNode.insertBefore(status,btn.nextSibling);
    }
  }
  window.addEventListener('message',function(event){
    var msg=event.data||{};
    if(msg.type==='of-save-both'){
      var rows=window._allRawRows||window._trAllRows||[];
      if(!rows.length){setStatus('⚠ Load a data file first',true);return;}
      runAutosave();
    }else if(msg.type==='of-autosave-ui-status'){
      setLocalStatus(msg.text||'',!!msg.bad);
    }else if(msg.type==='of-autosave-result'){
      var pending=pendingWrites[msg.requestId];
      if(!pending)return;
      delete pendingWrites[msg.requestId];
      if(msg.ok)pending.resolve(msg.path||msg.filename||'saved');
      else pending.reject(new Error(msg.message||'Could not save file'));
    }
  });
  function scheduleLocalButton(){setTimeout(ensureLocalButton,0);setTimeout(ensureLocalButton,300);setTimeout(ensureLocalButton,900);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',scheduleLocalButton);
  else scheduleLocalButton();
  setInterval(ensureLocalButton,1000);
})();
