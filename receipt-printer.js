/* ==========================================================================
   Event POS レシート＆精算サマリー Canvas画像変換・印字エンジン (ES5互換)
   ========================================================================== */

var ReceiptPrinter = (function() {
  var WIDTH = 384; // 58mmサーマルプリンタ標準ドット幅

  function padZero(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function formatDateTimeStr(isoOrDate) {
    if (!isoOrDate) return '-';
    var d = (isoOrDate instanceof Date) ? isoOrDate : new Date(isoOrDate);
    if (isNaN(d.getTime())) return String(isoOrDate);
    return d.getFullYear() + '-' + padZero(d.getMonth() + 1) + '-' + padZero(d.getDate()) + ' ' +
           padZero(d.getHours()) + ':' + padZero(d.getMinutes()) + ':' + padZero(d.getSeconds());
  }

  // CanvasのピクセルデータをESC/POS ラスタービットマップ (GS v 0) に変換
  function convertCanvasToEscPosBytes(canvas) {
    var totalHeight = canvas.height;
    var ctx = canvas.getContext('2d');
    var imgData = ctx.getImageData(0, 0, WIDTH, totalHeight).data;
    var bytesPerRow = WIDTH / 8;
    var escposBytes = [0x1B, 0x40]; // ESC @

    var CHUNK_H = 120;
    for (var startY = 0; startY < totalHeight; startY += CHUNK_H) {
      var h = Math.min(CHUNK_H, totalHeight - startY);
      escposBytes.push(0x1D, 0x76, 0x30, 0x00, bytesPerRow & 0xFF, (bytesPerRow >> 8) & 0xFF, h & 0xFF, (h >> 8) & 0xFF);

      for (var py = startY; py < startY + h; py++) {
        for (var bx = 0; bx < bytesPerRow; bx++) {
          var b = 0;
          for (var bit = 0; bit < 8; bit++) {
            var px = bx * 8 + bit;
            var idx = (py * WIDTH + px) * 4;
            var lum = 0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2];
            if (lum < 160) b |= (1 << (7 - bit));
          }
          escposBytes.push(b);
        }
      }
    }
    return escposBytes;
  }

  function createDrawingHelpers(ctx, measureOnly) {
    var state = { y: 16 };

    state.drawTextLine = function(text, fontSize, isBold, align, isShade, extraPad) {
      var pad = extraPad || 6;
      ctx.font = (isBold ? 'bold ' : '') + fontSize + 'px sans-serif';
      ctx.textBaseline = 'top';
      var tw = ctx.measureText(text).width;
      var lineH = Math.round(fontSize * 1.25);

      var x = 8;
      if (align === 'center') x = Math.max(8, (WIDTH - tw) / 2);
      else if (align === 'right') x = Math.max(8, WIDTH - tw - 8);

      if (!measureOnly) {
        if (isShade) {
          var boxX = Math.max(2, x - 12);
          var boxW = Math.min(WIDTH - 4, tw + 24);
          ctx.fillStyle = '#000';
          ctx.fillRect(boxX, state.y - 2, boxW, lineH + 4);
          ctx.fillStyle = '#fff';
          ctx.fillText(text, x, state.y);
        } else {
          ctx.fillStyle = '#000';
          ctx.fillText(text, x, state.y);
        }
      }
      state.y += lineH + pad;
    };

    state.drawMultilineBlock = function(rawText, fontSize, isBold, align, isShade) {
      var lines = String(rawText).split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        state.drawTextLine(lines[i] || ' ', fontSize, isBold, align, isShade, 6);
      }
    };

    state.drawLRLine = function(leftText, rightText, fontSize, isBold) {
      var lineH = Math.round(fontSize * 1.3);
      if (!measureOnly) {
        ctx.font = (isBold ? 'bold ' : '') + fontSize + 'px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#000';
        ctx.fillText(leftText, 8, state.y);
        var rw = ctx.measureText(rightText).width;
        ctx.fillText(rightText, Math.max(8, WIDTH - rw - 8), state.y);
      }
      state.y += lineH + 4;
    };

    state.drawDivider = function() {
      state.y += 6;
      if (!measureOnly) {
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (var dx = 4; dx < WIDTH - 4; dx += 10) {
          ctx.moveTo(dx, state.y);
          ctx.lineTo(dx + 6, state.y);
        }
        ctx.stroke();
      }
      state.y += 10;
    };

    return state;
  }

  function renderToBytes(drawFn) {
    var tempCanvas = document.createElement('canvas');
    tempCanvas.width = WIDTH;
    tempCanvas.height = 100;
    var totalHeight = drawFn(tempCanvas.getContext('2d'), true);

    var canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = totalHeight;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, WIDTH, totalHeight);
    drawFn(ctx, false);

    return convertCanvasToEscPosBytes(canvas);
  }

  function sendBytesToSunmi(rawBytes) {
    if (window.SunmiPrinter && typeof window.SunmiPrinter.printRawBase64 === 'function') {
      var bin = '';
      for (var i = 0; i < rawBytes.length; i++) bin += String.fromCharCode(rawBytes[i]);
      window.SunmiPrinter.printRawBase64(btoa(bin));
      return;
    }
    window.print();
  }

  // ① 通常お会計レシート印字
  function printOrderReceipt(params, receiptStyle) {
    var s = receiptStyle || {};
    var layout = (s.layout && s.layout.length > 0) ? s.layout : [
      { id: 'header', enabled: true },
      { id: 'meta', enabled: true },
      { id: 'call', enabled: true },
      { id: 'items', enabled: true },
      { id: 'totals', enabled: true },
      { id: 'footer', enabled: true }
    ];
    var sizeMap = { normal: 22, tall: 26, large: 34, xlarge: 52, xxlarge: 68 };

    var rawBytes = renderToBytes(function(ctx, measureOnly) {
      var h = createDrawingHelpers(ctx, measureOnly);
      var activeBlocks = [];
      for (var i = 0; i < layout.length; i++) {
        if (layout[i] && layout[i].enabled) activeBlocks.push(layout[i]);
      }

      for (var bIdx = 0; bIdx < activeBlocks.length; bIdx++) {
        var block = activeBlocks[bIdx];
        if (block.id === 'header' && s.titleText) {
          h.drawMultilineBlock(s.titleText, sizeMap[s.titleSize] || 34, s.titleBold !== false, s.titleAlign || 'center', !!s.titleShade);
        } else if (block.id === 'meta') {
          var mSize = sizeMap[s.metaSize] || 20;
          h.drawTextLine('日時: ' + params.receiptTime, mSize, !!s.metaBold, s.metaAlign || 'left', false, 4);
          h.drawTextLine('レジ: ' + params.registerId + ' / No: ' + params.dailyReceiptId, mSize, !!s.metaBold, s.metaAlign || 'left', false, 4);
        } else if (block.id === 'call') {
          var cAlign = s.callAlign || 'center';
          var label = (s.callLabel !== undefined && s.callLabel !== null) ? s.callLabel : '【お呼出番号】';
          if (label) h.drawTextLine(label, sizeMap[s.callLabelSize] || 22, !!s.callLabelBold, cAlign, false, 6);
          h.drawTextLine(params.callNumber, sizeMap[s.callSize] || 52, s.callBold !== false, cAlign, s.callShade !== false, 8);
        } else if (block.id === 'items') {
          var iSize = sizeMap[s.itemsSize] || 22;
          for (var j = 0; j < params.cart.length; j++) {
            var it = params.cart[j];
            h.drawTextLine(it.name, iSize, !!s.itemsBold, 'left', false, 2);
            h.drawTextLine('¥' + it.price.toLocaleString() + ' × ' + it.qty + '   ¥' + (it.price * it.qty).toLocaleString(), iSize, !!s.itemsBold, 'right', false, 6);
          }
        } else if (block.id === 'totals') {
          var tSize = sizeMap[s.totalSize || 'tall'] || 26;
          var tBold = s.totalBold !== false;
          h.drawLRLine('合計', '¥' + params.total.toLocaleString(), tSize, tBold);
          h.drawLRLine('お預かり', '¥' + params.tenderedAmount.toLocaleString(), 22, false);
          h.drawLRLine('お釣り', '¥' + params.change.toLocaleString(), tSize, tBold);
        } else if (block.id === 'footer' && s.footerText) {
          h.drawMultilineBlock(s.footerText, sizeMap[s.footerSize] || 22, !!s.footerBold, s.footerAlign || 'center', !!s.footerShade);
        }
        if (bIdx < activeBlocks.length - 1) h.drawDivider();
      }
      return h.y + 80;
    });

    sendBytesToSunmi(rawBytes);
  }

  // ② レジ締め・売上点検サマリーレシート印字
  function printSummaryReport(reportData, isCloseReport) {
    var rawBytes = renderToBytes(function(ctx, measureOnly) {
      var h = createDrawingHelpers(ctx, measureOnly);
      var title = isCloseReport ? '【レジ締め精算レポート】' : '【売上点検サマリー】';
      h.drawTextLine(title, 26, true, 'center', true, 10);
      h.drawTextLine('対象: レジ ' + reportData.registerId, 24, true, 'center', false, 6);
      h.drawDivider();

      h.drawTextLine('開始: ' + formatDateTimeStr(reportData.openedAt), 18, false, 'left', false, 4);
      h.drawTextLine('出力: ' + formatDateTimeStr(reportData.closedAt), 18, false, 'left', false, 6);
      h.drawDivider();

      h.drawLRLine('レジ準備金', '¥' + Number(reportData.initialCash || 0).toLocaleString(), 22, false);
      h.drawLRLine('会計回数', Number(reportData.receiptCount || 0).toLocaleString() + ' 回', 22, false);
      h.drawLRLine('総売上高', '¥' + Number(reportData.totalSalesAmount || 0).toLocaleString(), 26, true);
      h.drawDivider();

      h.drawTextLine('■ ドロワー理論在高', 20, true, 'left', false, 4);
      h.drawTextLine('¥' + Number(reportData.theoreticalDrawerCash || 0).toLocaleString(), 34, true, 'right', false, 8);
      h.drawDivider();

      h.drawTextLine('【商品別 販売実績】', 20, true, 'left', false, 6);
      var sales = reportData.itemSales || {};
      var hasItems = false;
      var totalQty = 0;
      for (var k in sales) {
        if (sales.hasOwnProperty(k) && sales[k] && sales[k].qty > 0) {
          hasItems = true;
          var it = sales[k];
          totalQty += it.qty;
          h.drawLRLine(it.name + ' ×' + it.qty, '¥' + Number(it.amount || 0).toLocaleString(), 20, false);
        }
      }
      if (!hasItems) {
        h.drawTextLine('販売実績なし', 18, false, 'left', false, 4);
      } else {
        h.drawLRLine('販売総個数', totalQty + ' 個', 20, true);
      }

      var hourly = reportData.hourlySales || {};
      var hKeys = [];
      for (var hk in hourly) {
        if (hourly.hasOwnProperty(hk) && hourly[hk] && hourly[hk].count > 0) hKeys.push(hk);
      }
      if (hKeys.length > 0) {
        hKeys.sort();
        h.drawDivider();
        h.drawTextLine('【時間帯別 売上】', 20, true, 'left', false, 6);
        for (var hi = 0; hi < hKeys.length; hi++) {
          var key = hKeys[hi];
          var hObj = hourly[key];
          h.drawLRLine(key + ':00台 (' + hObj.count + '件)', '¥' + Number(hObj.amount || 0).toLocaleString(), 19, false);
        }
      }

      h.drawDivider();
      h.drawTextLine(isCloseReport ? '精算完了' : '点検出力（営業継続中）', 20, true, 'center', false, 10);
      return h.y + 80;
    });

    sendBytesToSunmi(rawBytes);
  }

  return {
    printOrderReceipt: printOrderReceipt,
    printSummaryReport: printSummaryReport
  };
})();
