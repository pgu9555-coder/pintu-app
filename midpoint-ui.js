(function () {
  'use strict';
  var colors = ['#ee9476', '#638b68', '#799ba4', '#bd9b68', '#9a83a5', '#70867e'];
  var requestVersion = 0;
  SVG_PATHS.dice = 'M4 4h16v16H4z M8 8h.01 M16 8h.01 M12 12h.01 M8 16h.01 M16 16h.01';

  window.pintuSetMidpointState = function (result) {
    requestVersion++;
    document.getElementById('mpAdjustPlaces').hidden = !result;
    document.getElementById('viewMidpoint').classList.toggle('mp-has-result', result);
    return requestVersion;
  };
  window.pintuMidpointRequestIsCurrent = function (version) { return version === requestVersion; };
  window.pintuMidpointCurrentVersion = function () { return requestVersion; };

  function category(poi) { return poi.isMall ? 'mall' : poi.isDrink ? 'drink' : 'food'; }
  function cover(type) {
    // Category illustrations are deliberately not presented as photos of a venue.
    var art = type === 'mall'
      ? '<path fill="#8ba9a5" d="M20 23h25v49H20z"/><path fill="#456e69" d="M49 10h31v62H49z"/><path fill="#afbfac" d="M82 32h20v40H82z"/><path stroke="#e8eee3" stroke-width="2" d="M25 31h15m-15 9h15m-15 9h15m-15 9h15M55 20h19m-19 10h19m-19 10h19m-19 10h19m-19 10h19M86 41h12m-12 10h12m-12 10h12"/>'
      : type === 'drink'
      ? '<path fill="#b4c5ad" d="M15 13h90v59H15z"/><path fill="#e6e9dc" d="M22 20h76v45H22z"/><path stroke="#819a7b" stroke-width="2" d="M42 20v45m34-45v45M22 42h76"/><path fill="#fff9e8" d="M43 40h28v18a9 9 0 0 1-9 9H52a9 9 0 0 1-9-9z"/><path stroke="#fff9e8" stroke-width="4" fill="none" d="M71 44h6a7 7 0 0 1 0 14h-6"/><path stroke="#91a28b" stroke-width="2" fill="none" d="M51 32q-5-6 0-12m12 12q-5-6 0-12"/>'
      : '<path fill="#bba38b" d="M18 18h84v54H18z"/><path fill="#e6d7bb" d="M24 26h72v38H24z"/><path fill="#657d66" d="M54 26h13v38H54z"/><path stroke="#947c64" stroke-width="2" d="M20 18l8-8h64l10 8M35 26v38m50-38v38"/><ellipse cx="60" cy="63" rx="25" ry="4" fill="#c1ad8e"/><path fill="#faf4e6" d="M43 54h34a17 11 0 0 1-34 0"/><path stroke="#647e62" stroke-width="2" d="M47 51l6-9m11 9l-4-12m12 12l5-8"/>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="84" viewBox="0 0 120 84"><rect width="120" height="84" fill="#e9eadf"/><circle cx="106" cy="10" r="30" fill="#f6efdb"/>' + art + '<path fill="#d4ddcc" d="M0 72h120v12H0z"/></svg>');
  }
  function photo(poi) {
    var first = Array.isArray(poi.photos) && poi.photos[0];
    try {
      var url = new URL(first && (first.url || first));
      if (url.protocol === 'http:') url.protocol = 'https:';
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch (_) {}
    return '';
  }

  function filterPois(value) {
    var visible = 0;
    document.querySelectorAll('#poiList > .poi-card').forEach(function (card) {
      card.hidden = value !== 'all' && card.dataset.category !== value;
      if (!card.hidden) visible++;
      var panel = card.nextElementSibling;
      if (panel && panel.classList.contains('poi-expand-panel')) {
        panel.hidden = false;
        panel.style.display = !card.hidden && card.classList.contains('expanded') ? 'block' : 'none';
      }
    });
    document.querySelectorAll('[data-poi-filter]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.poiFilter === value));
    });
    document.getElementById('mpFilterEmpty').hidden = visible > 0;
    var total = (window.foodSwipeDeck || []).length;
    document.getElementById('mpPoiSummary').textContent = value === 'all'
      ? '为你找到 ' + total + ' 个好去处'
      : '找到 ' + visible + ' 个' + ({drink:'咖啡与茶饮',food:'餐厅',mall:'商圈'}[value] || '地点');
  }

  window.pintuRenderMidpointPois = function (pois) {
    var list = document.getElementById('poiList');
    list.replaceChildren();
    pois.forEach(function (poi) {
      var type = category(poi);
      var card = document.createElement('div');
      card.className = 'poi-card';
      card.dataset.category = type;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', '查看' + poi.name + '详情');
      card.addEventListener('keydown', function (event) {
        if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault(); card.click();
        }
      });
      var thumbnail = document.createElement('div');
      thumbnail.className = 'poi-icon';
      var img = document.createElement('img');
      var actual = photo(poi);
      img.alt = actual ? poi.name + '地点照片' : ({mall:'商圈',drink:'咖啡与茶饮',food:'餐厅'}[type] + '类目插画');
      img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.src = actual || cover(type);
      img.addEventListener('error', function () { img.onerror = null; img.src = cover(type); img.alt = '地点类目插画'; }, {once:true});
      thumbnail.appendChild(img);
      var info = document.createElement('div'); info.className = 'poi-info';
      var name = document.createElement('div'); name.className = 'poi-name'; name.textContent = poi.name;
      var sub = document.createElement('div'); sub.className = 'poi-sub';
      sub.textContent = ({mall:'商圈',drink:'咖啡与茶饮',food:'餐厅'}[type]) + ' · 距中点约 ' + poi.dist + ' 米';
      info.append(name, sub); card.append(thumbnail, info); list.appendChild(card);
    });
    filterPois('all');
  };

  window.pintuDrawMidpointMap = function (points, center) {
    if (!amapInstance) {
      amapInstance = new AMap.Map('realMap', { zoom:14, center:[center.lng,center.lat], mapStyle:'amap://styles/whitesmoke', viewMode:'2D' });
    } else { amapInstance.clearMap(); amapInstance.resize(); }
    allMapMarkers = [];
    points.forEach(function (point, index) {
      var color = colors[index % colors.length];
      new AMap.Polyline({map:amapInstance,path:[[point.lng,point.lat],[center.lng,center.lat]],strokeColor:color,strokeWeight:2,strokeOpacity:.8,strokeStyle:'dashed',zIndex:40});
      var marker = new AMap.Marker({
        map:amapInstance,position:[point.lng,point.lat],
        content:'<div class="mp-departure-pin" style="--pin-color:'+color+'"><span>'+String.fromCharCode(65+index)+'</span></div>',
        offset:new AMap.Pixel(-15,-36),title:'出发点 '+String.fromCharCode(65+index),zIndex:100
      });
      allMapMarkers.push(marker);
    });
    var midpoint = new AMap.Marker({
      map:amapInstance,position:[center.lng,center.lat],offset:new AMap.Pixel(-18,-18),zIndex:110,
      content:'<div class="mp-center-marker"><span class="mp-center-dot"></span><span class="mp-center-caption">参考中点</span></div>',title:'几何参考中点'
    });
    allMapMarkers.push(midpoint);
    amapInstance.setFitView(allMapMarkers,false,[68,68,84,68],15);
  };

  document.querySelectorAll('[data-poi-filter]').forEach(function (button) {
    button.addEventListener('click',function () { filterPois(button.dataset.poiFilter); });
  });
  document.querySelectorAll('[data-map-action]').forEach(function (button) {
    button.addEventListener('click',function () {
      if (!amapInstance) return;
      if (button.dataset.mapAction === 'fit') amapInstance.setFitView(allMapMarkers,false,[68,68,84,68],15);
      else if (button.dataset.mapAction === 'in') amapInstance.zoomIn();
      else amapInstance.zoomOut();
    });
  });
  document.getElementById('foodSwipeEntryCard').addEventListener('keydown',function (event) {
    if(event.key==='Enter'||event.key===' '){event.preventDefault();openFoodSwipe();}
  });
})();
