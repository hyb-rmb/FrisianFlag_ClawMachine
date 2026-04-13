(function () {
    "use strict";

    /** Ganti dengan URL halaman redeem / klaim hadiah yang sebenarnya. */
    var REDEEM_PRIZE_URL = "https://example.com/redeem";

    var ASSETS_BASE = [
        "assets/item_buku.png",
        "assets/item_choc.png",
        "assets/item_permen.png",
        "assets/item_phone.png",
        "assets/item_sayur.png",
        "assets/item_susu.png",
    ];
    var ASSETS = ASSETS_BASE.concat(ASSETS_BASE);

    var PRIZE_BY_SRC = (function () {
        var m = {};
        m["assets/item_buku.png"] = "Paket Buku Digital";
        m["assets/item_choc.png"] = "Cokelat Spesial";
        m["assets/item_permen.png"] = "Permen Hadiah";
        m["assets/item_phone.png"] = "Voucher Pulsa";
        m["assets/item_sayur.png"] = "Paket Sayur Segar";
        m["assets/item_susu.png"] = "Paket Susu Premium";
        return m;
    })();

    function prizeLabelFromSrc(src) {
        return PRIZE_BY_SRC[src] || "Hadiah spesial";
    }

    var canvas = document.getElementById("game");
    var ctx = canvas.getContext("2d");
    var scoreEl = document.getElementById("score");
    var scoreDupEl = document.getElementById("scoreDup");
    var popupWinEl    = document.getElementById("popupWin");
    var popupRetryEl  = document.getElementById("popupRetry");
    var btnRetryEl    = document.getElementById("btnRetry");
    var btnDrop = document.getElementById("btn-drop");
    var joystickEl = document.getElementById("joystick");
    var playsLeftEl = document.getElementById("playsLeft");
    var joystickDragging = false;
    /** Posisi pointer saat menggeser tuas (untuk offset dari tengah joystick). */
    var lastPointerClientX = 0;

    var MAX_PLAYS = Infinity; /* tidak ada batas bermain */

    /* Item yang menghasilkan popup MENANG */
    var WIN_ITEMS = ["item_buku", "item_sayur", "item_susu"];

    function isWinItem(src) {
        return WIN_ITEMS.some(function (name) { return src.indexOf(name) !== -1; });
    }

    function hideAllPopups() {
        if (popupWinEl)   popupWinEl.classList.add("hidden");
        if (popupRetryEl) popupRetryEl.classList.add("hidden");
    }

    function showPrizePopup(src) {
        hideAllPopups();
        if (isWinItem(src)) {
            if (popupWinEl) popupWinEl.classList.remove("hidden");
        } else {
            if (popupRetryEl) popupRetryEl.classList.remove("hidden");
        }
    }

    function hidePrizePopup() {
        hideAllPopups();
    }

    var W = canvas.width;
    var H = canvas.height;

    var railY = 100;
    /** Item tidak boleh melampaui batas ini agar tidak tertutup overlay kontrol. */
    var floorY = H - 136;  /* batas bawah area item, sesuai frame merah BG.jpg */
    var clawHalf = 30;     /* = CLAW_TARGET_W / 2, agar batas gerak sesuai lebar gambar */
    var grabW = 36;
    var clawTipBelow = 58;
    var dropSpeed = 2.2;
    var riseSpeed = 1.8;

    var images = [];
    var imagesLoaded = 0;
    var gameStarted = false;
    var prizeSize = 40;
    var pitPad = 9; /* jarak aman dari tepi kiri/kanan frame merah */
    var maxPrizeAngle = 0.35;

    /* Gambar capit PNG */
    var clawImgOpen = new Image();
    var clawImgClose = new Image();
    var clawImgLoaded = 0;
    clawImgOpen.src = "assets/claw_open.png";
    clawImgClose.src = "assets/claw_close.png";

    /** Lebar target capit (px) — tinggi dihitung otomatis sesuai aspect ratio asli gambar. */
    var CLAW_TARGET_W = 60;

    function randBetween(a, b) {
        return a + Math.random() * (b - a);
    }

    function shuffleInPlace(arr) {
        var i = arr.length;
        while (i > 1) {
            var j = (Math.random() * i) | 0;
            i--;
            var t = arr[i];
            arr[i] = arr[j];
            arr[j] = t;
        }
        return arr;
    }

    var state = {
        phase: "ready",
        clawX: W / 2,
        /** Arah tuas (langsung dari sentuhan / keyboard). */
        clawStickGoalX: W / 2,
        /** "Rel" perintah: mengikuti tuas perlahan. */
        clawDriveX: W / 2,
        ropeLen: 0,
        maxDrop: floorY - railY,
        prizes: [],
        score: 0,
        caught: null,
        messageTimer: 0,
        playsRemaining: Infinity,
    };

    function setPlaysDisplay() {
        if (playsLeftEl) playsLeftEl.textContent = String(state.playsRemaining);
    }

    function clawXBounds() {
        /* margin = pitPad agar tepi gambar capit sejajar dengan batas kiri/kanan frame */
        var margin = pitPad;
        return {
            min: margin + clawHalf,
            max: W - margin - clawHalf,
        };
    }

    function canSteerClaw() {
        return state.phase === "ready";
    }

    /**
     * Tuas → rel perintah → capit: dua tahap pelan supaya tidak melompat ke ujung rel.
     */
    var kStickToDrive = 0.062;
    var kDriveToClaw = 0.074;
    var maxStepDrive = 1.9;
    var maxStepClaw = 1.65;
    /** Kecepatan geser capit di rel saat tuas ditahan (px per frame, skala ±1). */
    var clawSteerRatePx = 1.95;

    function clampClawX(x) {
        var b = clawXBounds();
        if (x < b.min) return b.min;
        if (x > b.max) return b.max;
        return x;
    }

    function smoothToward(current, target, k, maxStep) {
        var dx = target - current;
        var step = dx * k;
        if (step > maxStep) step = maxStep;
        if (step < -maxStep) step = -maxStep;
        var next = current + step;
        if (Math.abs(target - next) < 0.42) return target;
        return next;
    }

    /** Offset pointer dari tengah joystick: -1 = kiri, +1 = kanan. */
    function joystickDeflectionNorm(clientX) {
        if (!joystickEl) return 0;
        var rect = joystickEl.getBoundingClientRect();
        var cx = rect.left + rect.width * 0.5;
        var half = Math.max(14, rect.width * 0.4);
        var n = (clientX - cx) / half;
        if (n < -1) n = -1;
        if (n > 1) n = 1;
        return n;
    }

    function smoothClawTowardTarget() {
        if (joystickDragging && joystickEl) {
            var n = joystickDeflectionNorm(lastPointerClientX);
            state.clawStickGoalX = clampClawX(
                state.clawStickGoalX + n * clawSteerRatePx
            );
        }
        var b = clawXBounds();
        state.clawStickGoalX = clampClawX(state.clawStickGoalX);
        state.clawDriveX = smoothToward(
            state.clawDriveX,
            state.clawStickGoalX,
            kStickToDrive,
            maxStepDrive
        );
        state.clawX = smoothToward(
            state.clawX,
            state.clawDriveX,
            kDriveToClaw,
            maxStepClaw
        );
        syncJoystickVisual();
    }

    function syncJoystickVisual() {
        if (!joystickEl) return;
        var img = joystickEl.querySelector(".joystick-img");
        var b = clawXBounds();
        var span = b.max - b.min;
        var maxAngle = 28;
        if (joystickDragging) {
            var n = joystickDeflectionNorm(lastPointerClientX);
            if (img) img.style.transform = "rotate(" + (n * maxAngle) + "deg)";
            joystickEl.setAttribute("aria-valuenow", String(Math.round((n + 1) * 50)));
        } else {
            if (img) img.style.transform = "rotate(0deg)";
            var tAria = span > 0 ? (state.clawX - b.min) / span : 0.5;
            if (tAria < 0) tAria = 0;
            if (tAria > 1) tAria = 1;
            joystickEl.setAttribute("aria-valuenow", String(Math.round(tAria * 100)));
        }
    }

    function initJoystickControl() {
        if (!joystickEl) return;
        function onPointerDown(e) {
            if (!canSteerClaw()) return;
            if (e.pointerType === "mouse" && e.button !== 0) return;
            joystickDragging = true;
            lastPointerClientX = e.clientX;
            joystickEl.classList.add("is-dragging");
            try {
                joystickEl.setPointerCapture(e.pointerId);
            } catch (err) { }
            syncJoystickVisual();
        }
        function onPointerMove(e) {
            if (!joystickDragging || !canSteerClaw()) return;
            lastPointerClientX = e.clientX;
        }
        function onPointerEnd(e) {
            joystickDragging = false;
            joystickEl.classList.remove("is-dragging");
            try {
                if (joystickEl.releasePointerCapture) {
                    joystickEl.releasePointerCapture(e.pointerId);
                }
            } catch (err2) { }
            syncJoystickVisual();
        }
        joystickEl.addEventListener("pointerdown", onPointerDown);
        joystickEl.addEventListener("pointermove", onPointerMove);
        joystickEl.addEventListener("pointerup", onPointerEnd);
        joystickEl.addEventListener("pointercancel", onPointerEnd);
        joystickEl.addEventListener("lostpointercapture", function () {
            joystickDragging = false;
            joystickEl.classList.remove("is-dragging");
            syncJoystickVisual();
        });
    }

    function setMessage(text, kind) {
        if (kind === "miss") {
            hidePrizePopup();
        }
    }

    function setScore(n) {
        var s = String(n);
        if (scoreEl) scoreEl.textContent = s;
        if (scoreDupEl) scoreDupEl.textContent = s;
    }

    function loadImages() {
        ASSETS.forEach(function (src, i) {
            var img = new Image();
            function tryStart() {
                imagesLoaded++;
                if (imagesLoaded === ASSETS.length && !gameStarted) {
                    gameStarted = true;
                    initPrizes();
                    loop();
                }
            }
            img.onload = tryStart;
            img.onerror = tryStart;
            img.src = src;
            images.push({ img: img, src: src, index: i });
        });
    }

    /**
     * true jika dua AABB tidak beririsan. gap: jarak minimum antar kotak (px) agar tidak nempel tumpang tindih.
     */
    function rectsSeparate(a, b, gap) {
        var g = gap != null ? gap : 0;
        return (
            a.x + a.w + g <= b.x ||
            b.x + b.w + g <= a.x ||
            a.y + a.h + g <= b.y ||
            b.y + b.h + g <= a.y
        );
    }

    function initPrizes() {
        var side = prizeSize | 0;
        var bubbleR = side / 2 + 5;
        var minDist = bubbleR * 2 + 3;   /* jarak minimum antar pusat bubble (tanpa tumpang tindih) */

        /* Batas area dalam koordinat PUSAT bubble */
        var cxMin = pitPad + bubbleR;
        var cxMax = W - pitPad - bubbleR;
        var cyTop = railY + 50 + bubbleR;   /* batas atas: di bawah rel */
        var cyBot = floorY - bubbleR - 2;   /* batas bawah: tepat di atas lantai */

        /*
         * Pisahkan item_phone ke posisi paling bawah (ditempatkan terakhir di cyBot).
         * Semua item lain diacak normal.
         */
        var phoneItems = images.filter(function (img) {
            return img.src.indexOf("item_phone") !== -1;
        });
        var otherItems = images.filter(function (img) {
            return img.src.indexOf("item_phone") === -1;
        });
        shuffleInPlace(otherItems);
        /* phone ditempatkan PERTAMA agar algoritma gravitasi meletakkannya paling bawah */
        var pool = phoneItems.concat(otherItems);
        var n = pool.length;

        /*
         * Algoritma gravitasi:
         * Setiap item "dijatuhkan" dari atas ke bawah.
         * Untuk setiap posisi X kandidat, hitung Y terendah (terbesar) yang masih
         * tidak bertabrakan dengan item yang sudah ditempatkan.
         * Pilih X yang menghasilkan posisi paling rendah (efek gravitasi).
         */
        var placed = [];   /* array {cx, cy} — koordinat pusat bubble */
        var pi, t, k;

        /*
         * Scan seluruh lebar secara merata (grid + jitter kecil) untuk menemukan
         * posisi X yang menghasilkan Y paling bawah (gravitasi).
         * Grid scan memastikan item mengisi penuh kiri-kanan tanpa celah besar.
         */
        var scanSteps = 80;  /* resolusi scan horizontal */
        var stepW = (cxMax - cxMin) / (scanSteps - 1);

        for (pi = 0; pi < n; pi++) {
            var isPhone = pool[pi].src.indexOf("item_phone") !== -1;
            var bestCx = -1, bestCy = -Infinity;

            for (t = 0; t < scanSteps; t++) {
                /* Posisi X merata + sedikit jitter agar tidak terlalu kaku */
                var cx = cxMin + t * stepW + randBetween(-stepW * 0.3, stepW * 0.3);
                cx = Math.max(cxMin, Math.min(cxMax, cx));

                /* Mulai dari lantai, dorong ke atas jika bertabrakan */
                var cy = cyBot;
                for (k = 0; k < placed.length; k++) {
                    var dx = cx - placed[k].cx;
                    if (Math.abs(dx) < minDist) {
                        var dyMin = Math.sqrt(minDist * minDist - dx * dx);
                        var maxCyHere = placed[k].cy - dyMin;
                        if (cy > maxCyHere) cy = maxCyHere;
                    }
                }
                /* Hanya valid jika masih di atas batas atas */
                if (cy < cyTop) continue;
                /* item_phone: pilih posisi PALING BAWAH (cy terbesar = paling susah dicapai) */
                /* item lain: pilih posisi paling bawah yang tersedia */
                if (cy > bestCy) {
                    bestCy = cy;
                    bestCx = cx;
                    /* item_phone berhenti di posisi pertama yang = cyBot (lantai penuh) */
                    if (isPhone && Math.abs(cy - cyBot) < 1) break;
                }
            }

            /* Fallback jika tidak ada posisi valid */
            if (bestCx === -1) {
                bestCx = randBetween(cxMin, cxMax);
                bestCy = cyBot;
            }
            placed.push({ cx: bestCx, cy: bestCy });
        }

        /* Konversi pusat → pojok kiri atas untuk x/y item */
        var positions = [];
        for (pi = 0; pi < n; pi++) {
            positions.push({
                x: Math.round(placed[pi].cx - side / 2),
                y: Math.round(placed[pi].cy - side / 2)
            });
        }

        var bubbleColors = [
            "rgba(140,210,255,0.72)",
            "rgba(175,155,240,0.72)",
            "rgba(120,220,175,0.72)",
            "rgba(255,205,120,0.72)",
            "rgba(255,165,195,0.72)",
            "rgba(160,230,230,0.72)",
            "rgba(200,215,255,0.72)",
        ];

        state.prizes = [];
        for (pi = 0; pi < n; pi++) {
            state.prizes.push({
                img: pool[pi].img,
                src: pool[pi].src,
                prizeLabel: prizeLabelFromSrc(pool[pi].src),
                x: positions[pi].x,
                y: positions[pi].y,
                w: side,
                h: side,
                angle: randBetween(-maxPrizeAngle, maxPrizeAngle),
                caught: false,
                visible: pool[pi].img.complete && pool[pi].img.naturalWidth > 0,
                bubbleColor: bubbleColors[pi % bubbleColors.length],
            });
        }

        state.prizes.sort(function (a, b) {
            if (a.y !== b.y) return a.y - b.y;
            return a.x - b.x;
        });
    }

    function drawBackground() {
        ctx.clearRect(0, 0, W, H);
    }

    function drawRail() {
        /* Rel tidak digambar — BG.jpg sudah menyediakan visual frame mesin. */
    }

    function clawBottomY() {
        return railY + state.ropeLen;
    }

    function fillRoundRect(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function drawClawRopeOnly() {
        var cx = state.clawX;
        var top = railY + 10;
        var ropeEnd = clawBottomY();

        /* Tali kabel tipis bergaris dua */
        ctx.strokeStyle = "#7a8a9c";
        ctx.lineWidth = 1.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(cx - 1, top);
        ctx.lineTo(cx - 1, ropeEnd);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, top);
        ctx.lineTo(cx, ropeEnd);
        ctx.stroke();
    }

    function drawClawHeadOnly() {
        var cx = state.clawX;
        var ropeEnd = clawBottomY();

        /* Pilih gambar: tutup saat fase rising/message dengan item tertangkap, buka saat lainnya */
        var isClosed = (state.caught !== null) &&
            (state.phase === "rising" || state.phase === "message");
        var clawImg = isClosed ? clawImgClose : clawImgOpen;

        /* Hitung ukuran render sesuai aspect ratio asli gambar */
        var drawW = CLAW_TARGET_W;
        var drawH = CLAW_TARGET_W;
        if (clawImg.complete && clawImg.naturalWidth > 0) {
            drawH = Math.round(CLAW_TARGET_W * clawImg.naturalHeight / clawImg.naturalWidth);
        }

        /* Gambar capit PNG — tengah di cx, top = ropeEnd */
        if (clawImg.complete && clawImg.naturalWidth > 0) {
            ctx.drawImage(
                clawImg,
                cx - drawW / 2,
                ropeEnd,
                drawW,
                drawH
            );
        }

        /* Item yang tertangkap — diposisikan di dalam prong capit (40% dari bawah gambar) */
        if (state.caught && state.caught.img) {
            var cr = state.caught.w / 2 + 4;
            /* Tengah bubble = 85% dari bawah gambar capit agar terlihat di ujung prong */
            var itemCY = ropeEnd + drawH * 0.85;
            var itemY = itemCY - cr;
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, itemCY, cr, 0, Math.PI * 2);
            ctx.fillStyle = state.caught.bubbleColor || "rgba(180,220,255,0.7)";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(cx, itemCY, cr, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(
                state.caught.img,
                cx - state.caught.w / 2,
                itemY,
                state.caught.w,
                state.caught.h
            );
            ctx.restore();
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx - cr * 10.3, itemCY - cr * 0.35, cr * 0.22, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255,255,255,0.5)";
            ctx.fill();
            ctx.restore();
        }
    }

    function drawPrizes() {
        state.prizes.forEach(function (p) {
            if (p.caught || !p.visible) return;
            var cx = p.x + p.w / 2;
            var cy = p.y + p.h / 2;
            var r = p.w / 2 + 5;

            ctx.save();
            try {
                /* Lingkaran bubble */
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = p.bubbleColor || "rgba(180,220,255,0.7)";
                ctx.fill();

                /* Gambar item di dalam bubble (clip ke lingkaran) */
                ctx.beginPath();
                ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
                ctx.clip();
                ctx.translate(cx, cy);
                ctx.rotate(p.angle);
                ctx.drawImage(p.img, -p.w / 2, -p.h / 2, p.w, p.h);
            } catch (e) { }
            ctx.restore();

            /* Border bubble dan shine — di luar clip agar tidak terpotong */
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255,255,255,0.75)";
            ctx.lineWidth = 1.5;
            ctx.stroke();

            /* Kilap kecil di kiri atas */
            ctx.beginPath();
            ctx.arc(cx - r * 0.3, cy - r * 0.32, r * 0.22, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255,255,255,0.55)";
            ctx.fill();
            ctx.restore();
        });
    }

    function tallCatchZone() {
        var cx = state.clawX;
        var bottom = clawBottomY();
        return {
            left: cx - grabW / 2,
            top: railY,
            right: cx + grabW / 2,
            bottom: bottom + clawTipBelow,
        };
    }

    function zoneOverlapsPrize(z, p) {
        return (
            z.left < p.x + p.w &&
            z.right > p.x &&
            z.top < p.y + p.h &&
            z.bottom > p.y
        );
    }

    function findCatch() {
        var z = tallCatchZone();
        var best = null;
        var bestTop = Infinity;
        var bestArea = -1;
        state.prizes.forEach(function (p) {
            if (p.caught || !p.visible) return;
            if (!zoneOverlapsPrize(z, p)) return;
            var ix = Math.min(z.right, p.x + p.w) - Math.max(z.left, p.x);
            var iy = Math.min(z.bottom, p.y + p.h) - Math.max(z.top, p.y);
            var area = Math.max(0, ix) * Math.max(0, iy);
            if (area <= 0) return;
            var topEdge = p.y;
            if (topEdge < bestTop - 1e-6) {
                bestTop = topEdge;
                bestArea = area;
                best = p;
            } else if (Math.abs(topEdge - bestTop) <= 1e-6) {
                if (area > bestArea) {
                    bestArea = area;
                    best = p;
                }
            }
        });
        return best;
    }

    function updateControls() {
        var busy =
            state.phase !== "ready" && state.phase !== "message";
        btnDrop.disabled = busy;
        if (!canSteerClaw()) {
            joystickDragging = false;
            if (joystickEl) joystickEl.classList.remove("is-dragging");
        }
        if (joystickEl) {
            joystickEl.classList.toggle(
                "joystick-unit--inactive",
                !canSteerClaw()
            );
            syncJoystickVisual();
        }
    }

    function tick() {
        if (state.phase === "message") {
            state.messageTimer--;
            if (state.messageTimer <= 0) {
                state.phase = "ready";
                state.ropeLen = 0;
                state.caught = null;
                state.clawStickGoalX = state.clawX;
                state.clawDriveX = state.clawX;
                setMessage("");
                updateControls();
            }
            return;
        }

        if (state.phase === "dropping") {
            state.ropeLen += dropSpeed;
            var hitNow = findCatch();
            if (hitNow) {
                state.caught = {
                    img: hitNow.img,
                    w: hitNow.w,
                    h: hitNow.h,
                    prizeLabel: hitNow.prizeLabel,
                    src: hitNow.src,
                };
                var rm = state.prizes.indexOf(hitNow);
                if (rm >= 0) state.prizes.splice(rm, 1);
                state.score += 10;
                setScore(state.score);
                setMessage("Mantap! Angkat ke atas…", "win");
                state.phase = "rising";
                updateControls();
                return;
            }
            if (state.ropeLen >= state.maxDrop) {
                state.ropeLen = state.maxDrop;
                setMessage("Belum kena — coba lagi!", "miss");
                state.phase = "rising";
                updateControls();
                return;
            }
            return;
        }

        if (state.phase === "rising") {
            state.ropeLen -= riseSpeed;
            if (state.ropeLen <= 0) {
                state.ropeLen = 0;
                state.phase = "message";
                state.messageTimer = 90;
                if (state.caught && state.caught.prizeLabel) {
                    showPrizePopup(state.caught.src || "");
                }
            }
            return;
        }

        if (state.phase === "ready") {
            smoothClawTowardTarget();
        }
    }

    function loop() {
        tick();
        drawBackground();
        drawRail();
        drawClawRopeOnly();
        drawPrizes();
        drawClawHeadOnly();
        requestAnimationFrame(loop);
    }

    function drop() {
        if (state.phase !== "ready") return;
        if (state.playsRemaining < 1) return;
        state.phase = "dropping";
        updateControls();
    }

    btnDrop.addEventListener("click", drop);
    initJoystickControl();
    syncJoystickVisual();

    function onPopupClose() {
        hidePrizePopup();
        initPrizes(); /* reset semua objek kembali penuh */
    }

    /* Popup menang — klik backdrop atau gambar end_card untuk tutup */
    var popupWinClose  = document.getElementById("popupWinClose");
    var popupWinClose2 = document.getElementById("popupWinClose2");
    if (popupWinClose)  popupWinClose.addEventListener("click", onPopupClose);
    if (popupWinClose2) popupWinClose2.addEventListener("click", onPopupClose);

    /* Popup retry — klik btn_retry untuk tutup & reset */
    if (btnRetryEl) btnRetryEl.addEventListener("click", onPopupClose);

    window.addEventListener("keydown", function (e) {
        if (e.repeat) return;
        if (prizePopupEl && !prizePopupEl.classList.contains("hidden")) {
            return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            if (canSteerClaw()) {
                e.preventDefault();
                var b = clawXBounds();
                var step = (b.max - b.min) * 0.05;
                if (e.key === "ArrowLeft") {
                    state.clawStickGoalX = Math.max(b.min, state.clawStickGoalX - step);
                } else {
                    state.clawStickGoalX = Math.min(b.max, state.clawStickGoalX + step);
                }
            }
            return;
        }
        if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            drop();
        }
    });

    setPlaysDisplay();
    updateControls();
    setMessage(
        "Tekan dan geser joystick untuk menggeser capit; lepas tuas kembali ke tengah. Lalu CAPIT. Kesempatan " +
        MAX_PLAYS +
        "×."
    );
    loadImages();
})();

(function () {
    "use strict";

    var DESIGN_W = 320;
    var DESIGN_H = 480;
    var INSET = 8;
    var MACHINE_BASE_W = 320;
    var MACHINE_BASE_H = 300;

    var slot = document.getElementById("creativeSlot");
    var root = document.getElementById("ad-root");

    function fitMachineCanvas() {
        /* canvas-inner kini position:absolute inset:0 — mengisi penuh shell via CSS, tidak perlu transform. */
    }

    function applyCreativeScale() {
        if (!slot || !root) return;
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        /* Skala mengisi viewport (min ~320×480); tumbuh di layar lebih besar, maks 2× agar tidak blur. */
        var s = Math.min(
            2.0,
            (vw - INSET * 2) / DESIGN_W,
            (vh - INSET * 2) / DESIGN_H
        );
        s = Math.max(0.5, s);
        slot.style.width = DESIGN_W * s + "px";
        slot.style.height = DESIGN_H * s + "px";
        root.style.transform = "scale(" + s + ")";
        root.style.transformOrigin = "top left";
        requestAnimationFrame(fitMachineCanvas);
    }

    window.addEventListener("resize", applyCreativeScale);
    window.addEventListener("orientationchange", applyCreativeScale);

    function runAfterLayout() {
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                applyCreativeScale();
                fitMachineCanvas();
            });
        });
    }

    function initMachineFit() {
        var shell = document.querySelector(".canvas-shell");
        if (shell && typeof ResizeObserver !== "undefined") {
            new ResizeObserver(fitMachineCanvas).observe(shell);
        }
        requestAnimationFrame(function () {
            requestAnimationFrame(fitMachineCanvas);
        });
    }

    if (document.readyState === "complete") {
        runAfterLayout();
    } else {
        window.addEventListener("load", runAfterLayout);
    }
    applyCreativeScale();
    initMachineFit();
})();
