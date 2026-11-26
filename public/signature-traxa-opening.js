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
        '<div class="sto-orb" aria-hidden="true"><i class="sto-spark s1"></i><i class="sto-spark s2"></i><i class="sto-spark s3"></i><div class="sto-orb-core"><svg class="sto-globe" viewBox="0 0 100 100" role="img" aria-label="Globe emas"><defs><radialGradient id="stoGoldGlobe" cx="32%" cy="24%"><stop offset="0" stop-color="#fff6d6"/><stop offset=".42" stop-color="#e6c16f"/><stop offset="1" stop-color="#73501d"/></radialGradient><clipPath id="stoGlobeClip"><circle cx="50" cy="50" r="44"/></clipPath></defs><circle cx="50" cy="50" r="45" fill="url(#stoGoldGlobe)" stroke="#fff0bd" stroke-width="1.8"/><g clip-path="url(#stoGlobeClip)"><ellipse class="globe-grid" cx="50" cy="50" rx="20" ry="44"/><ellipse class="globe-grid" cx="50" cy="50" rx="39" ry="44"/><path class="globe-grid" d="M7 50h86M12 31h76M12 69h76M20 15c16 10 44 10 60 0M20 85c16-10 44-10 60 0"/><path class="globe-land" d="M19 26l8-8 9 2 5 7-4 6-8 2-3 8-7-2-4-8zM46 18l8-5 10 4 2 8-7 5-1 8-8-2-5-8zM59 43l9-4 12 5 5 9-7 6-2 12-9 6-7-9-8-2-2-12zM32 55l8-5 7 5-2 9-8 5-7-7z"/></g><circle cx="50" cy="50" r="44" fill="none" stroke="#fff3c8" stroke-opacity=".7"/></svg></div></div>'+
        '<div class="sto-brand"><strong>SIGNATURE CLUB</strong><span>TRADING</span><small>THE FUTURE OF TRADING</small></div>'+
        '<div class="sto-markets"><span>GOLD</span><span>BITCOIN</span><span>WTI OIL</span></div>'+
        '<div class="sto-swipe" aria-label="Geser untuk masuk"><span class="sto-swipe-label">SWIPE TO ENTER</span><span class="sto-handle" role="button" aria-label="Geser untuk mulai">›</span></div>'+
      '</section>'+
      '<section class="sto-stage sto-stage-two">'+
        '<div class="sto-orb" aria-hidden="true"><i class="sto-spark s1"></i><i class="sto-spark s2"></i><i class="sto-spark s3"></i><div class="sto-orb-core"><svg class="sto-globe" viewBox="0 0 100 100" role="img" aria-label="Globe emas"><defs><radialGradient id="stoGoldGlobe" cx="32%" cy="24%"><stop offset="0" stop-color="#fff6d6"/><stop offset=".42" stop-color="#e6c16f"/><stop offset="1" stop-color="#73501d"/></radialGradient><clipPath id="stoGlobeClip"><circle cx="50" cy="50" r="44"/></clipPath></defs><circle cx="50" cy="50" r="45" fill="url(#stoGoldGlobe)" stroke="#fff0bd" stroke-width="1.8"/><g clip-path="url(#stoGlobeClip)"><ellipse class="globe-grid" cx="50" cy="50" rx="20" ry="44"/><ellipse class="globe-grid" cx="50" cy="50" rx="39" ry="44"/><path class="globe-grid" d="M7 50h86M12 31h76M12 69h76M20 15c16 10 44 10 60 0M20 85c16-10 44-10 60 0"/><path class="globe-land" d="M19 26l8-8 9 2 5 7-4 6-8 2-3 8-7-2-4-8zM46 18l8-5 10 4 2 8-7 5-1 8-8-2-5-8zM59 43l9-4 12 5 5 9-7 6-2 12-9 6-7-9-8-2-2-12zM32 55l8-5 7 5-2 9-8 5-7-7z"/></g><circle cx="50" cy="50" r="44" fill="none" stroke="#fff3c8" stroke-opacity=".7"/></svg></div></div>'+
        '<div class="sto-loading"><span class="sto-loading-label">INITIALIZING</span><div class="sto-percent"><span>0</span><small>%</small></div><div class="sto-progress"><i></i></div></div>'+
        '<div class="sto-log"><div>› Verifying member <b>OK</b></div><div>› Preparing your setup <b>OK</b></div><div>› Syncing live prices <b>OK</b></div><div>› Loading signals &amp; market data <b>OK</b></div><div>› Connecting to your dashboard <b>OK</b></div></div>'+
        '<div class="sto-footer-line"></div><div class="sto-welcome"><span>WELCOME BACK</span><strong>REZZA ON</strong></div>'+
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
      var began=performance.now(),duration=4800;
      function tick(now){
        var p=Math.min(1,(now-began)/duration);
        pct.textContent=String(Math.round(p*100));
        fill.style.width=(p*100)+'%';
        if(p<1){requestAnimationFrame(tick);return;}
        setTimeout(function(){root.classList.add('is-leaving');setTimeout(function(){root.remove();},800);},5600);
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