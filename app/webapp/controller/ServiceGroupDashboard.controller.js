sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageToast"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast) {
  "use strict";

  var TREND_DAYS_DEFAULT = 14;

  // SLA response/resolution windows per priority code, in hours — same
  // table used for the per-ticket SLA badges (Dashboard/Main controllers),
  // rolled up here into met/breached counts instead.
  var SLA_HOURS = {
    P1: { response: 1,   resolution: 4 },
    P2: { response: 4,   resolution: 24 },
    P3: { response: 24,  resolution: 72 },
    P4: { response: 120, resolution: 240 }
  };

  var PRIORITY_LABELS = {
    P1: "P1 — Immediate",
    P2: "P2 — Within 4 Hours",
    P3: "P3 — 1 Business Day",
    P4: "P4 — 5 Days"
  };

  return Controller.extend("itsm.ui.controller.ServiceGroupDashboard", {

    onInit: function () {
      this.getView().setModel(new JSONModel({
        trendData: [], stats: {}, slaSummary: { met: 0, breached: 0, byPriority: [] }, atRisk: [],
        distribution: { status: [], priority: [], category: [] }, workload: []
      }), "an");

      // Operational model. The KPI figures, engineer overload, aging and the
      // SLA donut are computed from live tickets in _loadOps(). The queue /
      // escalation / assignment / team rows below are representative defaults:
      // the current data model has no Escalation, Change-Request or team-level
      // rollup entity yet, so these are shown as static placeholders until
      // those entities exist (see the note returned to the user).
      this.getView().setModel(new JSONModel({
        kpi: { totalActive: 0, highCritical: 0, unassigned: 0, breached: 0, dueSoon: 0,
               avgResolution: "—", firstResponse: 0, changeRequests: 23 },
        slaDonut: [], engineers: [],
        aging: [], agingTotal: 0, agingOver7: 0,
        workQueue: [
          { icon: "sap-icon://person-placeholder", label: "Unassigned Tickets", count: 0, state: "Warning" },
          { icon: "sap-icon://employee", label: "Waiting for Engineer", count: 11, state: "Information" },
          { icon: "sap-icon://customer", label: "Waiting for Customer", count: 7, state: "None" },
          { icon: "sap-icon://arrow-top", label: "Escalated Today", count: 5, state: "Error" },
          { icon: "sap-icon://refresh", label: "Reopened Tickets", count: 4, state: "None" },
          { icon: "sap-icon://sys-enter-2", label: "Pending Approval", count: 2, state: "Success" }
        ],
        escalation: [
          { icon: "sap-icon://arrow-top", label: "Escalated Today", count: 5 },
          { icon: "sap-icon://high-priority", label: "Escalated This Week", count: 22 },
          { icon: "sap-icon://pending", label: "Pending Escalations", count: 7 },
          { icon: "sap-icon://sys-enter-2", label: "Resolved Escalations", count: 18 }
        ],
        assignment: [
          { icon: "sap-icon://employee", label: "Assigned Today", count: 32 },
          { icon: "sap-icon://person-placeholder", label: "Pending Assignment", count: 8 },
          { icon: "sap-icon://process", label: "Auto Assigned", count: 19 },
          { icon: "sap-icon://manager-insight", label: "Manual Assigned", count: 13 }
        ],
        teams: [
          { name: "Network Team", total: 120, open: 42, high: 8, avg: "4.5 hrs", sla: 96, state: "Success" },
          { name: "Infrastructure Team", total: 98, open: 31, high: 6, avg: "5.0 hrs", sla: 94, state: "Warning" },
          { name: "SAP Basis", total: 75, open: 18, high: 3, avg: "2.0 hrs", sla: 99, state: "Success" },
          { name: "Application Support", total: 82, open: 26, high: 5, avg: "3.8 hrs", sla: 95, state: "Success" },
          { name: "Database Team", total: 64, open: 14, high: 2, avg: "2.6 hrs", sla: 98, state: "Success" },
          { name: "Security Team", total: 48, open: 12, high: 2, avg: "3.0 hrs", sla: 97, state: "Success" }
        ]
      }), "ops");

      this._iTrendDays = TREND_DAYS_DEFAULT;

      // code -> name, for the side ticket table's Status/Priority columns
      // (plain string fields now, no more association to expand).
      this._mStatusName = {};
      this._mPriorityName = {};
      this._mCategoryName = {};
      this._mUserName = {};
      this._loadLookupMaps();

      // Charts are drawn as inline SVG (built in _svgDonut / _svgLine and
      // rendered through sap.ui.core.HTML) rather than VizFrame, so the donut
      // centre labels and the clean trend line match the dashboard design.

      this.getOwnerComponent().getRouter()
        .getRoute("serviceGroupDashboard")
        .attachPatternMatched(this._onMatched, this);
    },

    _loadLookupMaps: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();

      function loadType(sType, oTarget) {
        var oBinding = oModel.bindList("/LookupValues", null, [], [
          new Filter("lookupType", FilterOperator.EQ, sType)
        ]);
        return oBinding.requestContexts(0, 999).then(function (aCtx) {
          aCtx.forEach(function (c) { oTarget[c.getProperty("code")] = c.getProperty("name"); });
        });
      }

      // Engineer names for the workload widget (userId -> name).
      var oUserB = oModel.bindList("/Users", null, [], []);
      var pUsers = oUserB.requestContexts(0, 999).then(function (aCtx) {
        aCtx.forEach(function (c) { that._mUserName[c.getProperty("userId")] = c.getProperty("name"); });
      });

      Promise.all([
        loadType("STATUS", that._mStatusName),
        loadType("PRIORITY", that._mPriorityName),
        loadType("CATEGORY1", that._mCategoryName),
        pUsers
      ]).catch(function () { /* best-effort */ });
    },

    formatStatusName: function (sCode) { return this._mStatusName[sCode] || sCode || ""; },
    formatPriorityName: function (sCode) { return this._mPriorityName[sCode] || sCode || ""; },
    formatUserName: function (sUserId) { return this._mUserName[sUserId] || sUserId || "Unassigned"; },

    _onMatched: function () {
      // ServiceGroup-only screen. isServiceGroup/isAdmin comes from the
      // server-side currentUser() function (derived from the authenticated
      // identity, so a client cannot forge it). Anyone else is bounced back
      // to the dashboard before any analytics data is fetched.
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oCtx = oModel.bindContext("/currentUser(...)");
      oCtx.execute().then(function () {
        var oUser = oCtx.getBoundContext();
        var bAllowed = !!(oUser.getProperty("isServiceGroup") || oUser.getProperty("isAdmin"));
        if (!bAllowed) {
          MessageToast.show("Service Group Dashboard is available to the Service Group only.");
          that.getOwnerComponent().getRouter().navTo("dashboard");
          return;
        }
        that._loadTrends();
        that._loadStatsAndSla();
        that._loadDistributionAndWorkload();
        that._loadOps();
      }).catch(function () {
        // Could not confirm the role — fail closed rather than leak the screen.
        that.getOwnerComponent().getRouter().navTo("dashboard");
      });
    },

    /* ---------------------------------------------------------
     * Ticket distribution (by status / priority / category) and engineer
     * workload — one flat fetch of the tickets, bucketed client-side, the
     * same approach _loadTrends uses. Each bucket carries a percent so the
     * view can draw a proportional bar without a chart library.
     * ------------------------------------------------------- */
    _loadDistributionAndWorkload: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oB = oModel.bindList("/Tickets", null, [], [], {
        $select: "ticketID,status,priority,messageProcessor",
        $expand: "incidentForm($select=category1)"
      });

      oB.requestContexts(0, 9999).then(function (aContexts) {
        var mStatus = {}, mPriority = {}, mCategory = {}, mWorkload = {};
        var iTotal = aContexts.length;

        aContexts.forEach(function (oCtx) {
          var sStatus = oCtx.getProperty("status") || "UNKNOWN";
          var sPriority = oCtx.getProperty("priority") || "UNKNOWN";
          // V4: read the expanded child through its path — getProperty on the
          // whole "incidentForm" navigation object throws ("not primitive").
          var sCat = oCtx.getProperty("incidentForm/category1") || "UNCATEGORISED";
          var sEng = oCtx.getProperty("messageProcessor") || "__UNASSIGNED__";

          mStatus[sStatus] = (mStatus[sStatus] || 0) + 1;
          mPriority[sPriority] = (mPriority[sPriority] || 0) + 1;
          mCategory[sCat] = (mCategory[sCat] || 0) + 1;
          mWorkload[sEng] = (mWorkload[sEng] || 0) + 1;
        });

        function toRows(mCounts, mNames) {
          return Object.keys(mCounts).map(function (sKey) {
            return {
              code: sKey,
              name: (mNames && mNames[sKey]) || sKey,
              count: mCounts[sKey],
              percent: iTotal ? Math.round(mCounts[sKey] / iTotal * 100) : 0
            };
          }).sort(function (a, b) { return b.count - a.count; });
        }

        // Workload: friendly engineer names, "Unassigned" spelled out, busiest
        // first, capped to the top 8 so the widget stays readable.
        var aWorkload = Object.keys(mWorkload).map(function (sKey) {
          var iCount = mWorkload[sKey];
          return {
            name: sKey === "__UNASSIGNED__" ? "Unassigned" : (that._mUserName[sKey] || sKey),
            count: iCount,
            percent: iTotal ? Math.round(iCount / iTotal * 100) : 0
          };
        }).sort(function (a, b) { return b.count - a.count; }).slice(0, 8);

        var oAn = that.getView().getModel("an");
        oAn.setProperty("/distribution/status", toRows(mStatus, that._mStatusName));
        oAn.setProperty("/distribution/priority", toRows(mPriority, that._mPriorityName));
        oAn.setProperty("/distribution/category", toRows(mCategory, that._mCategoryName));
        oAn.setProperty("/workload", aWorkload);
      }).catch(function (oErr) {
        // eslint-disable-next-line no-console
        console.error("Service Group Dashboard distribution failed:", oErr);
      });
    },

    onTrendRangeChange: function (oEvent) {
      this._iTrendDays = parseInt(oEvent.getSource().getSelectedKey(), 10);
      this._loadTrends();
    },

    /* ---------------------------------------------------------
     * Chart rendering — inline SVG strings shown via sap.ui.core.HTML.
     * VizFrame can't produce a donut with a centre label or this clean a
     * line, so the charts are drawn directly to match the dashboard design.
     * ------------------------------------------------------- */
    _svgDonut: function (aSeg, sBig, sCap) {
      var C = 326.73;                                   // 2·π·52
      var iTotal = aSeg.reduce(function (s, x) { return s + (x.value || 0); }, 0);
      var iOffset = 0;
      var sRings = "";
      if (iTotal > 0) {
        aSeg.forEach(function (seg) {
          var iLen = (seg.value || 0) / iTotal * C;
          if (iLen > 0) {
            sRings += '<circle cx="59" cy="59" r="52" fill="none" stroke="' + seg.color +
              '" stroke-width="13" stroke-dasharray="' + iLen.toFixed(2) + ' ' + (C - iLen).toFixed(2) +
              '" stroke-dashoffset="' + (-iOffset).toFixed(2) + '"></circle>';
            iOffset += iLen;
          }
        });
      }
      return '<svg viewBox="0 0 118 118" width="118" height="118" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="59" cy="59" r="52" fill="none" stroke="#eef1f8" stroke-width="13"></circle>' +
        '<g transform="rotate(-90 59 59)">' + sRings + '</g>' +
        '<text x="59" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="19" font-weight="800" fill="#1e2a5e">' + sBig + '</text>' +
        '<text x="59" y="72" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#6b7280">' + sCap + '</text>' +
        '</svg>';
    },

    _svgLine: function (aData) {
      var W = 320, H = 120, PADX = 6, PADT = 12, PADB = 22;
      var iMax = 1;
      aData.forEach(function (d) { iMax = Math.max(iMax, d.created || 0, d.resolved || 0); });
      var iTop = Math.ceil(iMax / 5) * 5 || 5;
      var iN = aData.length;
      function x(i) { return PADX + (iN <= 1 ? 0 : i * (W - 2 * PADX) / (iN - 1)); }
      function y(v) { return PADT + (1 - (v || 0) / iTop) * (H - PADT - PADB); }
      function pts(sKey) { return aData.map(function (d, i) { return x(i) + "," + y(d[sKey]).toFixed(1); }).join(" "); }

      // faint gridlines
      var sGrid = "";
      [0, 0.5, 1].forEach(function (f) {
        var yy = (PADT + f * (H - PADT - PADB)).toFixed(1);
        sGrid += '<line x1="' + PADX + '" y1="' + yy + '" x2="' + (W - PADX) + '" y2="' + yy + '" stroke="#eef1f8" stroke-width="1"></line>';
      });
      // x labels: first, middle, last
      var sX = "";
      [0, Math.floor(iN / 2), iN - 1].forEach(function (i) {
        if (aData[i]) { sX += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#9ca3af">' + aData[i].date + '</text>'; }
      });
      var sCreated = pts("created"), sResolved = pts("resolved");
      var sArea = "M" + x(0) + "," + y(0) + " L" + sCreated.replace(/ /g, " L") + " L" + x(iN - 1) + "," + y(0) + " Z";

      return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="200" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        sGrid + sX +
        '<path d="' + sArea + '" fill="#3f4ff0" fill-opacity="0.07"></path>' +
        '<polyline points="' + sCreated + '" fill="none" stroke="#3f4ff0" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>' +
        '<polyline points="' + sResolved + '" fill="none" stroke="#22c55e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline>' +
        '</svg>';
    },

    /* ---------------------------------------------------------
     * Operational figures: KPI counts, engineer overload, ticket aging and
     * the SLA donut — all from one live ticket fetch, bucketed client-side.
     * (Standard OData binding + a JSON model; no custom controls.)
     * ------------------------------------------------------- */
    _loadOps: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oB = oModel.bindList("/Tickets", null, [], [], {
        $select: "ticketID,status,priority,messageProcessor,createdAt,firstResponseAt,completedAt"
      });

      oB.requestContexts(0, 9999).then(function (aCtx) {
        var iNow = Date.now();
        var DAY = 86400000;

        var iTotalActive = 0, iHighCritical = 0, iUnassigned = 0;
        var iWithin = 0, iDueSoon = 0, iBreached = 0;
        var mEng = {};                       // userId -> {assigned, high, overdue}
        var aAging = [
          { label: "0 – 1 Day", count: 0, color: "#16a34a" },
          { label: "1 – 3 Days", count: 0, color: "#1d4ed8" },
          { label: "3 – 7 Days", count: 0, color: "#eda100" },
          { label: "> 7 Days", count: 0, color: "#dc2626" }
        ];
        var iAgingTotal = 0;

        aCtx.forEach(function (c) {
          var sStatus = c.getProperty("status");
          if (sStatus === "CLOSED") { return; }   // operational view = open tickets
          iTotalActive++;

          var sPriority = c.getProperty("priority");
          var bHigh = sPriority === "P1" || sPriority === "P2";
          if (bHigh) { iHighCritical++; }

          var sEng = c.getProperty("messageProcessor");
          if (!sEng) { iUnassigned++; }

          // SLA state for this open ticket
          var oSla = that._computeSlaDetail(sPriority, c.getProperty("createdAt"),
            c.getProperty("firstResponseAt"), c.getProperty("completedAt"));
          var bOverdue = oSla.state === "Error";
          if (bOverdue) { iBreached++; }
          else if (oSla.state === "Warning") { iDueSoon++; }
          else { iWithin++; }

          // engineer overload
          if (sEng) {
            var e = mEng[sEng] || (mEng[sEng] = { assigned: 0, high: 0, overdue: 0 });
            e.assigned++;
            if (bHigh) { e.high++; }
            if (bOverdue) { e.overdue++; }
          }

          // aging
          var sCreated = c.getProperty("createdAt");
          if (sCreated) {
            var iAge = (iNow - new Date(sCreated).getTime()) / DAY;
            var iBucket = iAge <= 1 ? 0 : iAge <= 3 ? 1 : iAge <= 7 ? 2 : 3;
            aAging[iBucket].count++;
            iAgingTotal++;
          }
        });

        var aEngineers = Object.keys(mEng).map(function (sId) {
          var e = mEng[sId];
          var sState = (e.assigned >= 12 || e.overdue >= 3) ? "Overloaded"
            : (e.assigned >= 6 ? "Busy" : "Available");
          return {
            name: that._mUserName[sId] || sId,
            assigned: e.assigned, high: e.high, overdue: e.overdue,
            status: sState,
            state: sState === "Overloaded" ? "Error" : (sState === "Busy" ? "Warning" : "Success")
          };
        }).sort(function (a, b) { return b.assigned - a.assigned; }).slice(0, 6);

        var oOps = that.getView().getModel("ops");
        oOps.setProperty("/kpi/totalActive", iTotalActive);
        oOps.setProperty("/kpi/highCritical", iHighCritical);
        oOps.setProperty("/kpi/unassigned", iUnassigned);
        oOps.setProperty("/kpi/breached", iBreached);
        oOps.setProperty("/kpi/dueSoon", iDueSoon);
        oOps.setProperty("/engineers", aEngineers);
        oOps.setProperty("/slaDonut", [
          { name: "Within SLA", value: iWithin },
          { name: "Due in 2 Hours", value: iDueSoon },
          { name: "Breached", value: iBreached }
        ]);
        oOps.setProperty("/aging", aAging);
        oOps.setProperty("/agingTotal", iAgingTotal);
        oOps.setProperty("/agingOver7", aAging[3].count);

        // Donut SVGs (centre label + coloured segments), matching the design.
        var iSlaBase = iWithin + iDueSoon + iBreached;
        var iWithinPct = iSlaBase ? Math.round(iWithin / iSlaBase * 100) : 100;
        oOps.setProperty("/slaSvg", that._svgDonut([
          { value: iWithin, color: "#16a34a" },
          { value: iDueSoon, color: "#eda100" },
          { value: iBreached, color: "#dc2626" }
        ], iWithinPct + "%", "Within SLA"));
        oOps.setProperty("/agingSvg", that._svgDonut([
          { value: aAging[0].count, color: "#16a34a" },
          { value: aAging[1].count, color: "#1d4ed8" },
          { value: aAging[2].count, color: "#eda100" },
          { value: aAging[3].count, color: "#dc2626" }
        ], String(iAgingTotal), "Open"));

        // Keep the placeholder queue rows in step with the real unassigned count
        // so at least that row is live even before the other entities exist.
        oOps.setProperty("/workQueue/0/count", iUnassigned);
      }).catch(function (oErr) {
        // eslint-disable-next-line no-console
        console.error("Service Group Dashboard ops failed:", oErr);
      });
    },

    /* ---------------------------------------------------------
     * Tickets created vs resolved, bucketed by day for the selected
     * range. One flat fetch + client-side bucketing beats a day-by-day
     * query for a dataset this size.
     * ------------------------------------------------------- */
    _loadTrends: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oIncB = oModel.bindList("/Tickets", null, [], [], {
        $select: "ticketID,createdAt,completedAt"
      });

      oIncB.requestContexts(0, 9999).then(function (aContexts) {
        var oToday = new Date();
        oToday.setHours(0, 0, 0, 0);

        var aBuckets = [];
        var mByKey = {};
        for (var i = that._iTrendDays - 1; i >= 0; i--) {
          var oDate = new Date(oToday.getTime() - i * 86400000);
          var sKey = oDate.toISOString().slice(0, 10);
          var oBucket = {
            date: oDate.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
            created: 0,
            resolved: 0
          };
          aBuckets.push(oBucket);
          mByKey[sKey] = oBucket;
        }

        aContexts.forEach(function (oCtx) {
          var sCreated = oCtx.getProperty("createdAt");
          var sResolved = oCtx.getProperty("completedAt");
          if (sCreated && mByKey[sCreated.slice(0, 10)]) { mByKey[sCreated.slice(0, 10)].created++; }
          if (sResolved && mByKey[sResolved.slice(0, 10)]) { mByKey[sResolved.slice(0, 10)].resolved++; }
        });

        that.getView().getModel("an").setProperty("/trendData", aBuckets);
        that.getView().getModel("ops").setProperty("/trendSvg", that._svgLine(aBuckets));
      }).catch(function (oErr) {
        // eslint-disable-next-line no-console
        console.error("Service Group Dashboard trends failed:", oErr);
      });
    },

    /* ---------------------------------------------------------
     * Top KPI row + SLA compliance (met vs breached, per priority) + the
     * "At Risk" list (open tickets due soon but not yet breached). One
     * Ticket fetch covers all three — status/priority are plain string
     * fields now, so no more Lookup-ID indirection is needed to get a code
     * (unlike before this rewrite).
     * ------------------------------------------------------- */
    _loadStatsAndSla: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();

      var oIncB = oModel.bindList("/Tickets", null, [], [], {
        $select: "ticketID,ticketNumber,shortDescription,status,priority,messageProcessor,createdAt,firstResponseAt,completedAt"
      });

      oIncB.requestContexts(0, 9999).then(function (aInc) {
        var iClosed = 0;
        var iResSum = 0, iResCount = 0;
        var iOldestOpenAge = null;
        var iUnassigned = 0;
        var aAtRisk = [];

        var mByPriority = {};
        Object.keys(SLA_HOURS).forEach(function (c) { mByPriority[c] = { met: 0, breached: 0 }; });

        // "Vs last week" for the count-type tiles (At Risk/Breached/
        // Unassigned) — bucketed purely by createdAt, the only thing we
        // have real history for. Doesn't apply to Compliance %/Oldest
        // Open/Avg Resolution, which aren't simple counts.
        var iNow = Date.now();
        var WEEK_MS = 7 * 86400000;
        function weekBucket(sCreatedAt) {
          if (!sCreatedAt) { return null; }
          var iAge = iNow - new Date(sCreatedAt).getTime();
          if (iAge < WEEK_MS) { return "this"; }
          if (iAge < 2 * WEEK_MS) { return "last"; }
          return null;
        }
        function bump(oMap, sKey, sBucket) {
          if (!sBucket) { return; }
          if (sBucket === "this") { oMap[sKey].thisWeek++; }
          else { oMap[sKey].lastWeek++; }
        }
        var mMetricWeek = { unassigned: { thisWeek: 0, lastWeek: 0 }, breached: { thisWeek: 0, lastWeek: 0 }, atRisk: { thisWeek: 0, lastWeek: 0 } };

        aInc.forEach(function (oCtx) {
          if (oCtx.getProperty("status") === "CLOSED") { iClosed++; }

          var sCreated = oCtx.getProperty("createdAt");
          var sBucket = weekBucket(sCreated);

          if (!oCtx.getProperty("messageProcessor")) {
            iUnassigned++;
            bump(mMetricWeek, "unassigned", sBucket);
          }

          var sCompleted = oCtx.getProperty("completedAt");
          if (sCreated && sCompleted) {
            iResSum += (new Date(sCompleted).getTime() - new Date(sCreated).getTime());
            iResCount++;
          }

          if (!sCompleted && sCreated) {
            var iAge = Date.now() - new Date(sCreated).getTime();
            if (iOldestOpenAge === null || iAge > iOldestOpenAge) { iOldestOpenAge = iAge; }
          }

          var sCode = oCtx.getProperty("priority");
          if (sCode && mByPriority[sCode]) {
            var sFirstResponse = oCtx.getProperty("firstResponseAt");
            var oResult = that._computeSlaDetail(sCode, sCreated, sFirstResponse, sCompleted);
            if (oResult.state === "Error") {
              mByPriority[sCode].breached++;
              bump(mMetricWeek, "breached", sBucket);
            } else {
              mByPriority[sCode].met++;
            }

            if (!sCompleted && oResult.state === "Warning") {
              bump(mMetricWeek, "atRisk", sBucket);
              aAtRisk.push({
                ticketID: oCtx.getProperty("ticketID"),
                ticketNumber: oCtx.getProperty("ticketNumber"),
                shortDescription: oCtx.getProperty("shortDescription"),
                priority: sCode,
                deadline: oResult.deadline,
                dueText: that._formatTimeLeft(oResult.deadline - Date.now())
              });
            }
          }
        });

        aAtRisk.sort(function (a, b) { return a.deadline - b.deadline; });

        var iMetTotal = 0, iBreachedTotal = 0;
        var aByPriority = Object.keys(SLA_HOURS).map(function (sCode) {
          var o = mByPriority[sCode];
          iMetTotal += o.met;
          iBreachedTotal += o.breached;
          var iRowTotal = o.met + o.breached;
          return {
            label: PRIORITY_LABELS[sCode],
            met: o.met,
            breached: o.breached,
            percent: iRowTotal ? Math.round((o.met / iRowTotal) * 100) : 0,
            state: o.breached === 0 ? "Success" : (o.breached >= o.met ? "Error" : "Warning")
          };
        });

        var oAn = that.getView().getModel("an");
        oAn.setProperty("/stats", {
          atRisk: aAtRisk.length,
          breached: iBreachedTotal,
          compliancePercent: (iMetTotal + iBreachedTotal) ? Math.round((iMetTotal / (iMetTotal + iBreachedTotal)) * 100) : 100,
          oldestOpenAge: iOldestOpenAge === null ? "—" : that._formatDuration(iOldestOpenAge),
          avgResolution: iResCount ? that._formatDuration(iResSum / iResCount) : "—",
          unassigned: iUnassigned
        });
        oAn.setProperty("/slaSummary", { met: iMetTotal, breached: iBreachedTotal, byPriority: aByPriority });
        oAn.setProperty("/atRisk", aAtRisk);

        that._setTrendBadge("atRiskBadge", that._formatTrend(mMetricWeek.atRisk.thisWeek, mMetricWeek.atRisk.lastWeek));
        that._setTrendBadge("breachedBadge", that._formatTrend(mMetricWeek.breached.thisWeek, mMetricWeek.breached.lastWeek));
        that._setTrendBadge("unassignedBadge", that._formatTrend(mMetricWeek.unassigned.thisWeek, mMetricWeek.unassigned.lastWeek));
      }).catch(function (oErr) {
        // eslint-disable-next-line no-console
        console.error("Service Group Dashboard stats/SLA failed:", oErr);
      });
    },

    _formatDuration: function (iMs) {
      var iHours = iMs / 3600000;
      if (iHours < 24) { return iHours.toFixed(1) + "h"; }
      return (iHours / 24).toFixed(1) + "d";
    },

    // A small custom badge (plain Unicode arrows, not the SAP icon font —
    // no glyph-name guessing, full control over size/weight/color) instead
    // of GenericTile's own footer/indicator, which either don't render in
    // this compact frame type or don't look right. "This week" with
    // nothing to compare against (no matching tickets 7-14 days ago) reads
    // as "+N new" rather than a divide-by-zero percentage.
    // No "N new this week" number here on purpose — with no matching
    // tickets from last week, that count is always identical to the
    // tile's own number, which just reads as a confusing repeat of it.
    _formatTrend: function (iThisWeek, iLastWeek) {
      if (iLastWeek === 0) {
        return iThisWeek > 0
          ? { direction: "Up", label: "▲ all new" }
          : { direction: "None", label: "" };
      }
      var iPct = Math.round((iThisWeek - iLastWeek) / iLastWeek * 100);
      if (iPct === 0) { return { direction: "None", label: "No change from last week" }; }
      return {
        direction: iPct > 0 ? "Up" : "Down",
        label: (iPct > 0 ? "▲ " : "▼ ") + Math.abs(iPct) + "% from last week"
      };
    },

    _setTrendBadge: function (sId, oTrend) {
      var oBadge = this.byId(sId);
      if (!oBadge) { return; }
      oBadge.setText(oTrend.label);
      oBadge.toggleStyleClass("trendUp", oTrend.direction === "Up");
      oBadge.toggleStyleClass("trendDown", oTrend.direction === "Down");
    },

    _formatTimeLeft: function (iMs) {
      if (iMs <= 0) { return "Overdue"; }
      var iMinutes = iMs / 60000;
      if (iMinutes < 60) { return Math.round(iMinutes) + "m left"; }
      var iHours = iMs / 3600000;
      if (iHours < 24) { return iHours.toFixed(1) + "h left"; }
      return (iHours / 24).toFixed(1) + "d left";
    },

    /* ---------------------------------------------------------
     * Collapse/expand the tickets card — same behavior as the dashboard's
     * chart card toggle.
     * ------------------------------------------------------- */
    onToggleTiles: function () {
      this._bTilesCollapsed = !this._bTilesCollapsed;
      this.byId("tilesPane").toggleStyleClass("chartCollapsed", this._bTilesCollapsed);

      var oBtn = this.byId("tilesToggleBtn");
      oBtn.setIcon(this._bTilesCollapsed ? "sap-icon://slim-arrow-left" : "sap-icon://slim-arrow-right");
      oBtn.setTooltip(this._bTilesCollapsed ? "Expand" : "Collapse");
    },

    onGoDashboard: function () {
      this.getOwnerComponent().getRouter().navTo("dashboard");
    },

    onGoTickets: function () {
      this.getOwnerComponent().getRouter().navTo("sgTickets");
    },

    onTicketPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext();
      if (oCtx) {
        this.getOwnerComponent().getRouter().navTo("detail", { id: oCtx.getProperty("ticketID") });
      }
    },

    onAtRiskPress: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("an");
      if (oCtx) {
        this.getOwnerComponent().getRouter().navTo("detail", { id: oCtx.getProperty("ticketID") });
      }
    },

    // OData v4 delivers timestamps as ISO strings; format them for display.
    formatDateTime: function (sValue) {
      if (!sValue) { return ""; }
      var oDate = new Date(sValue);
      return isNaN(oDate.getTime()) ? "" : oDate.toLocaleString();
    },

    // Status/Priority -> sap.ui.core.ValueState. Keys off the plain code
    // now (not a display name) — see db/schema.cds.
    formatStatusState: function (sCode) {
      switch (sCode) {
        case "NEW": return "Information";
        case "IN_PROCESS": return "Warning";
        case "CUSTOMER_ACTION": return "Error";
        case "SOLUTION_PROPOSED": return "Warning";
        case "CONFIRMED": return "Success";
        case "CLOSED": return "Success";
        default: return "None";
      }
    },

    formatPriorityState: function (sCode) {
      switch (sCode) {
        case "P1": return "Error";
        case "P2": return "Warning";
        case "P3": return "Information";
        default: return "None";
      }
    },

    formatSlaState: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      return this._computeSlaDetail(sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt).state;
    },

    formatSlaText: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      return this._computeSlaDetail(sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt).text;
    },

    // Same response/resolution-window logic as the per-ticket SLA badges
    // on the dashboard/Main controllers — used both for the ticket table's
    // SLA column here and (state only) for the compliance summary above.
    _computeSlaDetail: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      var oWindow = SLA_HOURS[sPriorityCode];
      if (!oWindow || !sCreatedAt) { return { state: "None", text: "-" }; }

      var HOUR = 3600000;
      var iCreated = new Date(sCreatedAt).getTime();
      var iNow = Date.now();

      if (sCompletedAt) {
        var iResolveBy = iCreated + oWindow.resolution * HOUR;
        return new Date(sCompletedAt).getTime() <= iResolveBy
          ? { state: "Success", text: "SLA Met" }
          : { state: "Error", text: "SLA Breached" };
      }

      if (!sFirstResponseAt) {
        var iResponseBy = iCreated + oWindow.response * HOUR;
        var iLeft = iResponseBy - iNow;
        if (iLeft < 0) { return { state: "Error", text: "Response Overdue", deadline: iResponseBy }; }
        if (iLeft < oWindow.response * HOUR * 0.25) { return { state: "Warning", text: "Response Due Soon", deadline: iResponseBy }; }
        return { state: "Success", text: "On Track", deadline: iResponseBy };
      }

      var iResolveBy2 = iCreated + oWindow.resolution * HOUR;
      var iLeft2 = iResolveBy2 - iNow;
      if (iLeft2 < 0) { return { state: "Error", text: "Resolution Overdue", deadline: iResolveBy2 }; }
      if (iLeft2 < oWindow.resolution * HOUR * 0.25) { return { state: "Warning", text: "Due Soon", deadline: iResolveBy2 }; }
      return { state: "Success", text: "On Track", deadline: iResolveBy2 };
    }

  });
});
