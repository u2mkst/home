/* ============================================================================
   KST 화면 키보드 (vkeyboard.js)
   ----------------------------------------------------------------------------
   학원 태블릿(neotab 등)이 제조사마다 서로 다른 시스템 키보드를 쓰는 바람에
   화면·배열이 제각각이라, 글자를 입력할 일이 있는 칸에서는 항상 이 화면 자체
   키보드를 쓰게 한다. 터치 기기(태블릿·폰)에서만 켜지고, 마우스+실제 키보드를
   쓰는 PC에서는 아무 일도 하지 않는다(실제 키보드는 inputmode="none"과 무관하게
   그대로 동작한다).

   사용법: 입력칸에 inputmode="none"과 data-kbd="numeric|alnum|full" 을 달아두면
   포커스될 때 자동으로 뜬다(이 스크립트가 document에 위임 이벤트로 감시).
   - numeric: 숫자만(PIN·전화번호 뒷자리·학급 번호 등)
   - alnum  : 영문+숫자(아이디·비밀번호 등, 한글 필요 없음)
   - full   : 한글(두벌식)+영문+숫자(이름·문의사항 등 자유 입력)
   data-kbd-sign="true"를 더하면 숫자 키패드에 +/-, . 를 추가로 보여준다
   (오늘의 문제 정답처럼 음수·소수가 나올 수 있는 칸용).

   한글 조합은 흔히 쓰는 표준 두벌식 입력 규칙(초성+중성+종성, 겹모음·겹받침
   조합, 받침 뒤에 모음이 오면 다음 글자 초성으로 넘어가는 것)을 구현한다.
   다만 커서를 글 중간으로 옮긴 뒤 그 자리에서 다시 조합을 이어가는 것까지는
   지원하지 않는다 — 커서가 방금 조합한 글자 바로 뒤가 아니면 새 글자로 다시
   시작한다. 일반적인 이름·짧은 문의 글 입력에는 충분하다.
============================================================================ */
(function () {
    'use strict';

    /* ---------------------------------------------------------------------
       1. 한글 조합 엔진 (표준 두벌식)
    --------------------------------------------------------------------- */
    var CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
    var JUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
    var JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

    var CHO_IDX = {}; CHO.forEach(function (c, i) { CHO_IDX[c] = i; });
    var JUNG_IDX = {}; JUNG.forEach(function (c, i) { JUNG_IDX[c] = i; });
    var JONG_IDX = {}; JONG.forEach(function (c, i) { if (c) JONG_IDX[c] = i; });

    // 겹모음: 앞 모음 idx + 새로 누른 모음 글자 -> 합쳐진 모음 idx
    var VOWEL_COMPOUND = {
        8: { 'ㅏ': 9, 'ㅐ': 10, 'ㅣ': 11 },   // ㅗ + ㅏ/ㅐ/ㅣ
        13: { 'ㅓ': 14, 'ㅔ': 15, 'ㅣ': 16 }, // ㅜ + ㅓ/ㅔ/ㅣ
        18: { 'ㅣ': 19 }                       // ㅡ + ㅣ
    };
    // 겹받침: 앞 받침 idx + 새로 누른 자음 글자 -> 합쳐진 받침 idx
    var JONG_COMPOUND = {
        1: { 'ㅅ': 3 },                                                  // ㄱ+ㅅ=ㄳ
        4: { 'ㅈ': 5, 'ㅎ': 6 },                                          // ㄴ+ㅈ/ㅎ
        8: { 'ㄱ': 9, 'ㅁ': 10, 'ㅂ': 11, 'ㅅ': 12, 'ㅌ': 13, 'ㅍ': 14, 'ㅎ': 15 }, // ㄹ+...
        17: { 'ㅅ': 18 }                                                 // ㅂ+ㅅ=ㅄ
    };
    // 겹받침을 "다음 글자 초성으로 넘길 때" 둘로 나누는 표: [남을 받침 idx, 넘어갈 자음]
    var JONG_SPLIT = { 3: [1, 'ㅅ'], 5: [4, 'ㅈ'], 6: [4, 'ㅎ'], 9: [8, 'ㄱ'], 10: [8, 'ㅁ'], 11: [8, 'ㅂ'], 12: [8, 'ㅅ'], 13: [8, 'ㅌ'], 14: [8, 'ㅍ'], 15: [8, 'ㅎ'], 18: [17, 'ㅅ'] };

    var VOWEL_SET = {}; JUNG.forEach(function (c) { VOWEL_SET[c] = true; });

    function syllable(choI, jungI, jongI) {
        return String.fromCharCode(0xAC00 + (choI * 21 + jungI) * 28 + (jongI || 0));
    }

    // 조합기 하나 = 지금 조합 중인 글자 한 칸의 상태. press()/backspace()를 부르면
    // 그 결과로 "입력칸에서 마지막 N글자를 이걸로 바꿔라"는 지시를 돌려준다.
    function HangulComposer() { this.reset(); }
    HangulComposer.prototype.reset = function () { this.cho = null; this.jung = null; this.jong = null; };
    HangulComposer.prototype.isEmpty = function () { return this.cho == null && this.jung == null; };
    HangulComposer.prototype.render = function () {
        if (this.cho == null && this.jung == null) return '';
        if (this.jung == null) return CHO[this.cho];               // 자음 하나만 (아직 모음 없음)
        if (this.cho == null) return JUNG[this.jung];               // 모음 하나만 (드묾)
        return syllable(this.cho, this.jung, this.jong);
    };
    // 글자 하나(자음 또는 모음)를 누름. 결과: { replace: 지금 칸에 넣을 새 글자(들),
    // carry: 이전에 이미 확정된 글자 뒤에 붙는지 여부 } — 호출부가 이 결과로 입력칸을 고친다.
    HangulComposer.prototype.press = function (ch) {
        var isVowel = !!VOWEL_SET[ch];
        if (isVowel) {
            if (this.cho == null && this.jung == null) { this.jung = JUNG_IDX[ch]; return { replace: this.render() }; }
            if (this.jung == null) { this.jung = JUNG_IDX[ch]; return { replace: this.render() }; }
            if (this.jong == null) {
                var vc = VOWEL_COMPOUND[this.jung] && VOWEL_COMPOUND[this.jung][ch];
                if (vc != null) { this.jung = vc; return { replace: this.render() }; }
                // 조합 불가 -> 지금 글자 확정하고 모음 단독으로 새 칸 시작
                this.reset(); this.jung = JUNG_IDX[ch];
                return { commitPrev: true, replace: this.render() };
            }
            // 받침이 있는데 모음이 또 오면: 받침을 다음 글자 초성으로 넘긴다("간"+"ㅏ"->"가나")
            var moveChar, keepJongI;
            if (JONG_SPLIT[this.jong]) { keepJongI = JONG_SPLIT[this.jong][0]; moveChar = JONG_SPLIT[this.jong][1]; }
            else { keepJongI = 0; moveChar = JONG[this.jong]; }
            var finished = syllable(this.cho, this.jung, keepJongI);
            this.reset(); this.cho = CHO_IDX[moveChar]; this.jung = JUNG_IDX[ch];
            return { commitPrev: true, replace: finished + this.render(), splitCarry: true };
        }
        // 자음
        if (this.cho == null && this.jung == null) { this.cho = CHO_IDX[ch]; return { replace: this.render() }; }
        if (this.jung == null) { // 자음 단독 상태에서 또 자음 -> 확정하고 새로 시작
            this.reset(); this.cho = CHO_IDX[ch]; return { commitPrev: true, replace: this.render() };
        }
        if (this.jong == null) {
            if (JONG_IDX[ch] != null) { this.jong = JONG_IDX[ch]; return { replace: this.render() }; }
            this.reset(); this.cho = CHO_IDX[ch]; return { commitPrev: true, replace: this.render() };
        }
        var jc = JONG_COMPOUND[this.jong] && JONG_COMPOUND[this.jong][ch];
        if (jc != null) { this.jong = jc; return { replace: this.render() }; }
        this.reset(); this.cho = CHO_IDX[ch]; return { commitPrev: true, replace: this.render() };
    };
    // 백스페이스 한 단계: 종성 -> 중성 -> 초성 순으로 한 겹씩 벗긴다.
    HangulComposer.prototype.backspace = function () {
        if (this.jong != null) { this.jong = null; return { replace: this.render(), empty: false }; }
        if (this.jung != null) { this.jung = null; return { replace: this.render(), empty: this.cho == null }; }
        if (this.cho != null) { this.cho = null; return { replace: '', empty: true }; }
        return { replace: '', empty: true };
    };

    /* ---------------------------------------------------------------------
       2. 기기 판별: 터치 기기(태블릿·폰)에서만 켠다. 마우스+실제 키보드만
          쓰는 PC는 손대지 않는다(실제 키보드는 inputmode와 무관하게 동작).
    --------------------------------------------------------------------- */
    var TOUCH_LIKE = !!window.AndroidApp || 'ontouchstart' in window ||
        (navigator.maxTouchPoints || 0) > 0 ||
        (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    if (!TOUCH_LIKE) return;

    /* ---------------------------------------------------------------------
       3. 입력칸 조작 유틸 — 기존 oninput/onchange 리스너가 그대로 동작하도록
          진짜 이벤트를 흘려보낸다(값만 바꾸면 자동저장 등 기존 로직이 안 돈다).
    --------------------------------------------------------------------- */
    function nativeSetValue(el, value) {
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        desc.set.call(el, value);
    }
    function fireInput(el) { el.dispatchEvent(new Event('input', { bubbles: true })); }
    function fireChange(el) { el.dispatchEvent(new Event('change', { bubbles: true })); }
    function fireKey(el, type, key) { el.dispatchEvent(new KeyboardEvent(type, { key: key, bubbles: true, cancelable: true })); }

    function caret(el) { return { s: el.selectionStart || 0, e: el.selectionEnd || 0 }; }
    function setCaret(el, pos) { try { el.setSelectionRange(pos, pos); } catch (e) { /* 일부 input type은 지원 안 함(number 등) */ } }

    // 캐럿 위치에 text를 끼워 넣는다(선택 영역이 있으면 그 자리를 대체).
    function insertAt(el, text) {
        var c = caret(el), v = el.value;
        var max = el.maxLength;
        var room = (max != null && max >= 0) ? Math.max(0, max - (v.length - (c.e - c.s))) : Infinity;
        if (text.length > room) text = text.slice(0, room);
        var next = v.slice(0, c.s) + text + v.slice(c.e);
        nativeSetValue(el, next);
        fireInput(el);
        setCaret(el, c.s + text.length);
    }
    // 캐럿 바로 앞 n글자를 지우고(또는 선택영역을 지우고) text로 바꾼다.
    function replaceBeforeCaret(el, n, text) {
        var c = caret(el), v = el.value;
        if (c.s !== c.e) { // 선택 영역이 있으면 그냥 그 자리를 바꾼다
            var next = v.slice(0, c.s) + text + v.slice(c.e);
            nativeSetValue(el, next); fireInput(el); setCaret(el, c.s + text.length);
            return;
        }
        var from = Math.max(0, c.s - n);
        var next2 = v.slice(0, from) + text + v.slice(c.s);
        nativeSetValue(el, next2); fireInput(el); setCaret(el, from + text.length);
    }
    function backspaceOne(el) {
        var c = caret(el), v = el.value;
        if (c.s !== c.e) { var n = v.slice(0, c.s) + v.slice(c.e); nativeSetValue(el, n); fireInput(el); setCaret(el, c.s); return; }
        if (c.s === 0) return;
        var n2 = v.slice(0, c.s - 1) + v.slice(c.s);
        nativeSetValue(el, n2); fireInput(el); setCaret(el, c.s - 1);
    }

    /* ---------------------------------------------------------------------
       4. 키패드 레이아웃 데이터
    --------------------------------------------------------------------- */
    // 두벌식 글자 배열(화면에 보이는 모양 그대로) — 기본/Shift
    var HANGUL_ROWS = [
        ['ㅂ', 'ㅈ', 'ㄷ', 'ㄱ', 'ㅅ', 'ㅛ', 'ㅕ', 'ㅑ', 'ㅐ', 'ㅔ'],
        ['ㅁ', 'ㄴ', 'ㅇ', 'ㄹ', 'ㅎ', 'ㅗ', 'ㅓ', 'ㅏ', 'ㅣ'],
        ['ㅋ', 'ㅌ', 'ㅊ', 'ㅍ', 'ㅠ', 'ㅜ', 'ㅡ']
    ];
    var HANGUL_ROWS_SHIFT = [
        ['ㅃ', 'ㅉ', 'ㄸ', 'ㄲ', 'ㅆ', 'ㅛ', 'ㅕ', 'ㅑ', 'ㅒ', 'ㅖ'],
        ['ㅁ', 'ㄴ', 'ㅇ', 'ㄹ', 'ㅎ', 'ㅗ', 'ㅓ', 'ㅏ', 'ㅣ'],
        ['ㅋ', 'ㅌ', 'ㅊ', 'ㅍ', 'ㅠ', 'ㅜ', 'ㅡ']
    ];
    var ENG_ROWS = [
        ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
        ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
        ['z', 'x', 'c', 'v', 'b', 'n', 'm']
    ];
    var SYMBOL_ROWS = [
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
        ['-', '/', ':', ';', '(', ')', '₩', '&', '@', '"'],
        ['.', ',', '?', '!', "'", '%', '+', '=']
    ];

    /* ---------------------------------------------------------------------
       5. 키보드 패널 하나만 만들어서 재사용(싱글톤)
    --------------------------------------------------------------------- */
    var panel = null, activeEl = null, family = null, mode = null, shift = false;
    var composer = new HangulComposer();
    var lastComposedLen = 0; // 지금 조합 중인 글자가 입력칸에서 차지하는 글자 수(바로 앞칸만 교체 대상)

    function buildPanel() {
        var p = document.createElement('div');
        p.id = 'kstVKeyboard';
        p.className = 'kst-vkbd';
        p.innerHTML =
            '<div class="kst-vkbd-top">' +
            '  <div class="kst-vkbd-tabs" id="kvkTabs"></div>' +
            '  <button type="button" class="kst-vkbd-close" id="kvkClose" aria-label="키보드 닫기">닫기 ⌄</button>' +
            '</div>' +
            '<div class="kst-vkbd-rows" id="kvkRows"></div>';
        document.body.appendChild(p);
        p.addEventListener('pointerdown', function (e) { e.preventDefault(); }); // 포커스 안 뺏기게
        document.getElementById('kvkClose').addEventListener('pointerdown', function (e) { e.preventDefault(); hide(); });
        return p;
    }

    function key(label, cls, handler) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'kst-vkbd-key' + (cls ? ' ' + cls : '');
        b.textContent = label;
        b.addEventListener('pointerdown', function (e) { e.preventDefault(); handler(); });
        return b;
    }

    function commitComposer() { composer.reset(); lastComposedLen = 0; }

    function handleJamoPress(ch) {
        var r = composer.press(ch);
        if (r.commitPrev && !r.splitCarry) {
            insertAt(activeEl, r.replace);
            lastComposedLen = composer.render().length;
        } else if (r.splitCarry) {
            // 이전 글자(받침 뺀 모양)까지 포함한 두 글자를 한 번에 끼워 넣는다.
            replaceBeforeCaret(activeEl, lastComposedLen, r.replace);
            lastComposedLen = composer.render().length;
        } else {
            replaceBeforeCaret(activeEl, lastComposedLen, r.replace);
            lastComposedLen = r.replace.length;
        }
    }
    function handleHangulBackspace() {
        if (lastComposedLen > 0 && !composer.isEmpty()) {
            var r = composer.backspace();
            replaceBeforeCaret(activeEl, lastComposedLen, r.replace);
            lastComposedLen = r.replace.length;
            if (r.empty) commitComposer();
        } else {
            commitComposer();
            backspaceOne(activeEl);
        }
    }
    function handlePlainInsert(ch) { commitComposer(); insertAt(activeEl, ch); }
    function handlePlainBackspace() { commitComposer(); backspaceOne(activeEl); }
    function handleSpace() { commitComposer(); insertAt(activeEl, ' '); }
    function handleEnter() {
        commitComposer();
        if (activeEl.tagName === 'TEXTAREA') { insertAt(activeEl, '\n'); return; }
        fireKey(activeEl, 'keydown', 'Enter'); fireKey(activeEl, 'keyup', 'Enter');
        fireChange(activeEl);
        hide();
    }

    function renderNumeric() {
        var wrap = document.getElementById('kvkRows'); wrap.innerHTML = '';
        var grid = document.createElement('div'); grid.className = 'kst-vkbd-numgrid';
        ['1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(function (n) {
            grid.appendChild(key(n, 'kst-vkbd-num', function () { handlePlainInsert(n); }));
        });
        var signCell = activeEl && activeEl.dataset.kbdSign === 'true' ? key('−/+', 'kst-vkbd-num', function () { toggleSign(); }) : document.createElement('div');
        signCell.className += ' kst-vkbd-num';
        grid.appendChild(signCell);
        grid.appendChild(key('0', 'kst-vkbd-num', function () { handlePlainInsert('0'); }));
        if (activeEl && activeEl.dataset.kbdSign === 'true') grid.appendChild(key('.', 'kst-vkbd-num', function () { handlePlainInsert('.'); }));
        else grid.appendChild(key('⌫', 'kst-vkbd-num kst-vkbd-del', function () { handlePlainBackspace(); }));
        wrap.appendChild(grid);
        var bottom = document.createElement('div'); bottom.className = 'kst-vkbd-row kst-vkbd-bottom';
        if (activeEl && activeEl.dataset.kbdSign === 'true') bottom.appendChild(key('⌫', 'kst-vkbd-del kst-vkbd-wide', function () { handlePlainBackspace(); }));
        bottom.appendChild(key('완료', 'kst-vkbd-enter kst-vkbd-wide', handleEnter));
        wrap.appendChild(bottom);
    }
    function toggleSign() {
        if (!activeEl.value) { insertAt(activeEl, '-'); return; }
        var v = activeEl.value;
        var next = v.charAt(0) === '-' ? v.slice(1) : '-' + v;
        nativeSetValue(activeEl, next); fireInput(activeEl); setCaret(activeEl, next.length);
    }

    function renderAlnum() {
        var wrap = document.getElementById('kvkRows'); wrap.innerHTML = '';
        ENG_ROWS.forEach(function (row, i) {
            var rowEl = document.createElement('div'); rowEl.className = 'kst-vkbd-row';
            if (i === 2) rowEl.appendChild(key('⇧', 'kst-vkbd-shift' + (shift ? ' active' : ''), function () { shift = !shift; renderAlnum(); }));
            row.forEach(function (ch) {
                var disp = shift ? ch.toUpperCase() : ch;
                rowEl.appendChild(key(disp, '', function () { handlePlainInsert(shift ? ch.toUpperCase() : ch); if (shift) { shift = false; renderAlnum(); } }));
            });
            if (i === 2) rowEl.appendChild(key('⌫', 'kst-vkbd-del', handlePlainBackspace));
            wrap.appendChild(rowEl);
        });
        var bottom = document.createElement('div'); bottom.className = 'kst-vkbd-row kst-vkbd-bottom';
        if (family === 'full') bottom.appendChild(key('한글', 'kst-vkbd-switch', function () { mode = 'hangul'; render(); }));
        bottom.appendChild(key('123', 'kst-vkbd-switch', function () { mode = 'symbol'; render(); }));
        bottom.appendChild(key('스페이스', 'kst-vkbd-space', handleSpace));
        bottom.appendChild(key('완료', 'kst-vkbd-enter', handleEnter));
        wrap.appendChild(bottom);
    }

    function renderSymbol() {
        var wrap = document.getElementById('kvkRows'); wrap.innerHTML = '';
        SYMBOL_ROWS.forEach(function (row) {
            var rowEl = document.createElement('div'); rowEl.className = 'kst-vkbd-row';
            row.forEach(function (ch) { rowEl.appendChild(key(ch, '', function () { handlePlainInsert(ch); })); });
            wrap.appendChild(rowEl);
        });
        var bottom = document.createElement('div'); bottom.className = 'kst-vkbd-row kst-vkbd-bottom';
        if (family === 'full') bottom.appendChild(key('한글', 'kst-vkbd-switch', function () { mode = 'hangul'; render(); }));
        bottom.appendChild(key('영문', 'kst-vkbd-switch', function () { mode = 'eng'; render(); }));
        bottom.appendChild(key('⌫', 'kst-vkbd-del', handlePlainBackspace));
        bottom.appendChild(key('완료', 'kst-vkbd-enter', handleEnter));
        wrap.appendChild(bottom);
    }

    function renderHangul() {
        var wrap = document.getElementById('kvkRows'); wrap.innerHTML = '';
        HANGUL_ROWS.forEach(function (row, i) {
            var shiftRow = HANGUL_ROWS_SHIFT[i];
            var rowEl = document.createElement('div'); rowEl.className = 'kst-vkbd-row';
            if (i === 0) rowEl.appendChild(key('⇧', 'kst-vkbd-shift' + (shift ? ' active' : ''), function () { shift = !shift; renderHangul(); }));
            row.forEach(function (ch, j) {
                var disp = shift ? shiftRow[j] : ch;
                rowEl.appendChild(key(disp, '', function () { handleJamoPress(shift ? shiftRow[j] : ch); if (shift && i === 0) { shift = false; renderHangul(); } }));
            });
            if (i === 2) rowEl.appendChild(key('⌫', 'kst-vkbd-del', handleHangulBackspace));
            wrap.appendChild(rowEl);
        });
        var bottom = document.createElement('div'); bottom.className = 'kst-vkbd-row kst-vkbd-bottom';
        bottom.appendChild(key('영문', 'kst-vkbd-switch', function () { mode = 'eng'; render(); }));
        bottom.appendChild(key('123', 'kst-vkbd-switch', function () { mode = 'symbol'; render(); }));
        bottom.appendChild(key('스페이스', 'kst-vkbd-space', handleSpace));
        bottom.appendChild(key('완료', 'kst-vkbd-enter', handleEnter));
        wrap.appendChild(bottom);
    }

    function renderTabs() {
        var tabs = document.getElementById('kvkTabs');
        tabs.innerHTML = '';
        if (family !== 'full') return;
        [['hangul', '한글'], ['eng', '영문'], ['symbol', '123']].forEach(function (t) {
            var b = document.createElement('button');
            b.type = 'button'; b.textContent = t[1];
            b.className = 'kst-vkbd-tab' + (mode === t[0] ? ' active' : '');
            b.addEventListener('pointerdown', function (e) { e.preventDefault(); mode = t[0]; render(); });
            tabs.appendChild(b);
        });
    }

    function render() {
        commitComposer();
        renderTabs();
        if (family === 'numeric') { renderNumeric(); return; }
        if (mode === 'eng') { renderAlnum(); return; }
        if (mode === 'symbol') { renderSymbol(); return; }
        renderHangul();
    }

    /* ---------------------------------------------------------------------
       6. 보이기/숨기기, 포커스 위임 처리
    --------------------------------------------------------------------- */
    function show(el) {
        if (!panel) panel = buildPanel();
        activeEl = el;
        family = el.dataset.kbd || 'full';
        shift = false;
        mode = family === 'numeric' ? 'num' : family === 'alnum' ? 'eng' : 'hangul';
        panel.dataset.family = family;
        panel.classList.add('open');
        document.body.classList.add('kst-vkbd-open');
        render();
        setTimeout(function () {
            try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
        }, 60);
    }
    function hide() {
        if (panel) panel.classList.remove('open');
        document.body.classList.remove('kst-vkbd-open');
        commitComposer();
        activeEl = null;
    }

    document.addEventListener('focusin', function (e) {
        var el = e.target;
        if (!el || !el.dataset || !el.dataset.kbd) return;
        if (el.disabled || el.readOnly) return;
        show(el);
    });
    document.addEventListener('focusout', function (e) {
        var el = e.target;
        if (!el || !el.dataset || !el.dataset.kbd) return;
        // 키보드 버튼을 누른 거면(포인터다운에서 이미 preventDefault 했음) 포커스가 안 빠진다.
        // 진짜로 다른 곳을 탭해서 포커스가 빠진 경우에만 닫는다.
        setTimeout(function () {
            if (document.activeElement !== el) hide();
        }, 0);
    });
})();
