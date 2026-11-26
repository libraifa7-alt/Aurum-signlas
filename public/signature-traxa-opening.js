/* Creates an independent opening overlay; does not alter dashboard markup or behavior. */
(function(){
  if(window.__signatureTraxaOpeningLoaded) return;
  window.__signatureTraxaOpeningLoaded=true;

  function start(){
    if(document.getElementById('signature-traxa-opening')) return;
    var root=document.createElement('div');
    root.id='signature-traxa-opening';
    root.setAttribute('role','dialog');
    root.setAttribute('aria-label','Signature Trading opening screen');
    root.innerHTML=
      '<section class="sto-stage sto-stage-one is-active">'+
        '<div class="sto-orb" aria-hidden="true"><i class="sto-spark s1"></i><i class="sto-spark s2"></i><i class="sto-spark s3"></i><div class="sto-orb-core"><span class="sto-mark">S</span></div></div>'+
        '<div class="sto-brand"><strong>AURUM</strong><span>S I G N A L S</span><small>THE FUTURE OF TRADING</small></div>'+
        '<div class="sto-markets"><span>GOLD</span><span>BITCOIN</span><span>WTI OIL</span></div>'+
        '<div class="sto-swipe" aria-label="Geser untuk masuk"><span class="sto-swipe-label">SWIPE TO ENTER</span><span class="sto-handle" role="button" aria-label="Geser untuk mulai">›</span></div>'+
      '</section>'+
      '<section class="sto-stage sto-stage-two">'+
        '<div class="sto-orb" aria-hidden="true"><i class="sto-spark s1"></i><i class="sto-spark s2"></i><i class="sto-spark s3"></i><div class="sto-orb-core"><span class="sto-mark">S</span></div></div>'+
        '<div class="sto-loading"><span class="sto-loading-label">INITIALIZING</span><div class="sto-percent"><span>0</span><small>%</small></div><div class="sto-progress"><i></i></div></div>'+
        '<div class="sto-log"><div>› Verifying member <b>OK</b></div><div>› Preparing your setup <b>OK</b></div><div>› Syncing live prices <b>OK</b></div><div>› Loading signals &amp; market data <b>OK</b></div><div>› Connecting to your dashboard <b>OK</b></div></div>'+
        '<div class="sto-footer-line"></div><div class="sto-welcome"><span>WELCOME BACK</span><strong>WINENGKU</strong></div>'+
      '</section>';
    document.body.appendChild(root);
    var bar=root.querySelector('.sto-swipe');
    var handle=root.querySelector('.sto-handle');
    var pct=root.querySelector('.sto-percent span');
    var fill=root.querySelector('.sto-progress i');
    var dragging=false,startX=0,max=0,progress=0,done=false;
    function measure(){max=Math.max(0,bar.clientWidth-handle.offsetWidth-8);}
    function setProgress(v){progress=Math.max(0,Math.min(1,v));handle.style.left=(4+max*progress)+'px';}
    function begin(e){if(done)return;measure();dragging=true;startX=e.clientX;handle.setPointerCapture&&handle.setPointerCapture(e.pointerId);}
    function move(e){if(!dragging)return;setProgress((e.clientX-startX)/Math.max(1,max));if(progress>.92)enter();}
    function end(){if(!dragging)return;dragging=false;if(progress<.92)setProgress(0);}
    function enter(){
      if(done)return;done=true;dragging=false;root.classList.add('is-loading');
      var began=performance.now(),duration=5200;
      function tick(now){
        var p=Math.min(1,(now-began)/duration);
        pct.textContent=String(Math.round(p*100));
        fill.style.width=(p*100)+'%';
        if(p<1){requestAnimationFrame(tick);return;}
        setTimeout(function(){root.classList.add('is-leaving');setTimeout(function(){root.remove();},800);},450);
      }
      requestAnimationFrame(tick);
    }
    handle.addEventListener('pointerdown',begin);
    bar.addEventListener('pointermove',move);
    bar.addEventListener('pointerup',end);
    bar.addEventListener('pointercancel',end);
    bar.addEventListener('click',function(e){if(!done&&e.target!==handle)enter();});
    window.addEventListener('resize',function(){measure();setProgress(progress);});
    measure();setProgress(0);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();