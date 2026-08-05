sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, Filter, FilterOperator, Sorter, MessageToast, MessageBox) {
  "use strict";

  // Root of the category tree. Everything below it is discovered via parent_ID,
  // so new levels/values are added in master data, not here.
  var CAT_ROOT_TYPE = "CATEGORY1";
  var CAT_PAGE_SIZE = 500;

  // SLA response/resolution windows per priority code, in hours. Matches
  // (loosely) the descriptions in the PRIORITY lookup master data —
  // P1 "Immediate", P2 "within 4 hours", P3 "1 business day", P4 "5 days".
  var SLA_HOURS = {
    P1: { response: 1,   resolution: 4 },
    P2: { response: 4,   resolution: 24 },
    P3: { response: 24,  resolution: 72 },
    P4: { response: 120, resolution: 240 }
  };

  // STATUS codes — plain strings now (not LookupValue associations), see
  // db/schema.cds. submitTicket() is the only door out of Draft (service.cds).
  var STATUS_DRAFT = "DRAFT";
  var STATUS_NEW = "NEW";

  // Human labels for TicketHistory rows — the backend now logs the raw field
  // name (see srv/utils/history.js), not a pre-resolved label like before.
  var HISTORY_FIELD_LABELS = {
    ticketType: "Ticket Type", shortDescription: "Short Description", status: "Status",
    priority: "Final Priority", reportedBy: "Reported By", messageProcessor: "Assigned To",
    supportTeam: "Support Team", firstResponseAt: "First Response By", dueAt: "Due By",
    completedAt: "Completed On", description: "Full Description",
    category1: "Category 1", category2: "Category 2", category3: "Category 3", category4: "Category 4",
    solutionCategory: "Solution Category", impact: "Impact", urgency: "Urgency",
    recommendedPriority: "Recommended Priority", configurationItem: "Configuration Item",
    relatedRFC: "Related RFC"
  };

  return Controller.extend("itsm.ui.controller.Main", {

    /* ---------------------------------------------------------
     * Lifecycle
     * ------------------------------------------------------- */
    onInit: function () {
      // Local model for pending attachments (before incident is saved)
      this.getView().setModel(new JSONModel({ list: [], countLabel: "Attachments: 0" }), "attachments");

      // Change-history timeline (empty until an existing ticket is loaded).
      this.getView().setModel(new JSONModel({ list: [] }), "hist");

      // Drives header buttons and form editability by mode.
      this.getView().setModel(new JSONModel({}), "ui");

      // userId -> display name, for the read-only "Reported By" field.
      // Best-effort: loaded once here, formatUserName falls back to the raw
      // id until (or if) this resolves.
      this._mUserNames = {};
      this._loadUserNames();

      // The form is shared by two routes: "create" (new draft) and
      // "detail" (view an existing ticket). The view is cached and reused, so
      // the per-visit setup lives in the route-matched handlers, not onInit.
      var oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("create").attachPatternMatched(this._onCreateMatched, this);
      oRouter.getRoute("detail").attachPatternMatched(this._onDetailMatched, this);
    },

    _loadUserNames: function () {
      var that = this;
      var oBinding = this.getOwnerComponent().getModel().bindList("/Users");
      oBinding.requestContexts(0, 999).then(function (aContexts) {
        aContexts.forEach(function (oCtx) {
          that._mUserNames[oCtx.getProperty("userId")] = oCtx.getProperty("name");
        });
      }).catch(function () { /* best-effort */ });
    },

    formatUserName: function (sUserId) {
      if (!sUserId) { return ""; }
      return this._mUserNames[sUserId] || sUserId;
    },

    /**
     * Switch the form between "create", "view" and "edit". Everything the
     * header and fields react to lives in the "ui" model, so the view stays
     * declarative. The header title itself is a fixed app name (see the
     * view); "ticketLabel" carries the ticket-specific id/placeholder that
     * shows below it instead.
     */
    _setMode: function (sMode) {
      this._sMode = sMode;
      // Not this._oIncidentContext.getProperty("ticketNumber") — nothing
      // in the view binds that property anymore (the ID field was removed
      // in favor of showing it in the header), so the v4 model never fetches
      // it into its cache and getProperty() on it silently comes back
      // undefined. _sIncidentNumber is populated once via requestProperty()
      // (see _getIncidentNumber) and reused here instead.
      var sNumber = this._sIncidentNumber;

      // A ticket reopened while still in Draft (saved but never submitted)
      // behaves like the create screen: Save keeps it a draft, Submit is
      // what actually moves it to New.
      var bIsDraft = !!this._oIncidentContext
        && this._oIncidentContext.getProperty("status") === STATUS_DRAFT;

      var mModes = {
        create: {
          ticketLabel: "New Ticket",
          subtitle: "Creating New Service Request Record",
          formEditable: true,
          saveLabel: "Save",
          saveEnabled: true,
          showBack: true, showEdit: false, showSave: true, showSubmit: true, showDelete: false
        },
        view: {
          ticketLabel: sNumber || "Ticket",
          subtitle: "Viewing service request",
          formEditable: false,
          saveLabel: bIsDraft ? "Save" : "Save",
          saveEnabled: true,
          showBack: true, showEdit: true, showSave: false, showSubmit: false, showDelete: false
        },
        edit: {
          ticketLabel: sNumber || "Ticket",
          subtitle: "Editing service request",
          formEditable: true,
          saveLabel: bIsDraft ? "Save" : "Save",
          saveEnabled: true,
          // Only a persisted Draft can be deleted — once a ticket leaves
          // Draft it's part of the recorded process flow (history, SLA
          // clocks), so deletion is blocked both here and server-side.
          showBack: true, showEdit: false, showSave: true, showSubmit: bIsDraft, showDelete: bIsDraft
        }
      };
      this.getView().getModel("ui").setData(mModes[sMode]);
      this._syncFormFade(mModes[sMode].formEditable);
    },

    /* ---------------------------------------------------------
     * View mode: fields are already read-only, but fade the whole form
     * too so it visibly reads as "look, don't touch" until Edit is
     * pressed — full opacity/interactive again the moment it is.
     * Binding a "class" directly (plain or expression syntax) silently
     * fails to resolve in this UI5 build, so it's toggled here instead.
     * ------------------------------------------------------- */
    _syncFormFade: function (bEditable) {
      var bFaded = !bEditable;
      ["secGeneral", "secProcessing", "secRelationships", "secAttachments"].forEach(function (sId) {
        var oSection = this.byId(sId);
        if (oSection) { oSection.toggleStyleClass("formFaded", bFaded); }
      }, this);
    },

    /* ---------------------------------------------------------
     * Route: create — always starts a genuinely fresh, blank ticket.
     * (This used to resume whatever Draft was last in progress, so
     * "New Ticket" could silently reopen an old, half-filled-in draft
     * instead of a blank form — surprising, and not what "New" implies.
     * Existing drafts are still fully reachable, just from the dashboard
     * list rather than being auto-resumed here.)
     * ------------------------------------------------------- */
    _onCreateMatched: function () {
      this._setAttachmentsList([]);
      this.getView().getModel("hist").setProperty("/list", []);
      this._createDraftIncident();
      this._setMode("create");
      this._setupCategories();
      this._prefillReportedBy();
      this._scrollToTop();
    },

    /**
     * "Reported By" is server-assigned (beforeCreateTicket always
     * overwrites it with the logged-in user's id) — this just mirrors that
     * onto the transient context so the read-only field shows the right
     * name immediately, instead of blank until the first Save round-trip.
     */
    _prefillReportedBy: function () {
      var oCtx = this._oIncidentContext;
      var oModel = this.getOwnerComponent().getModel();
      var oAction = oModel.bindContext("/currentUser(...)");
      oAction.execute().then(function () {
        var sUserId = oAction.getBoundContext().getProperty("userId");
        if (sUserId) { oCtx.setProperty("reportedBy", sUserId); }
      }).catch(function () { /* best-effort — see above */ });
    },

    /* ---------------------------------------------------------
     * Route: detail — bind an existing ticket, read-only to start.
     * ------------------------------------------------------- */
    _onDetailMatched: function (oEvent) {
      var that = this;
      var sId = oEvent.getParameter("arguments").id;
      this._sIncidentNumber = null; // reset — a new context is about to be bound
      this._bindExistingIncident(sId);
      this._setMode("view");
      // The number and status arrive with the record; refresh the ticket
      // label and the Save/Submit labels (draft-aware) once loaded.
      this._getIncidentNumber().then(function (sNo) {
        that.getView().getModel("ui").setProperty("/ticketLabel", sNo || "Ticket");
      }).catch(function () { /* ignore */ });
      this._oIncidentContext.requestProperty("status").then(function (sStatus) {
        // A Draft is inherently unfinished — open it straight into edit
        // mode (where Submit is reachable) instead of the read-only view,
        // which doesn't even show a Submit button.
        that._setMode(sStatus === STATUS_DRAFT ? "edit" : that._sMode);
      }).catch(function () { /* ignore */ });
      this._setupCategories();
      this._loadHistory(sId);
      this._loadAttachments(sId);
      this._scrollToTop();
    },

    /* ---------------------------------------------------------
     * The router moves focus into the new view for accessibility,
     * which the browser answers by scrolling the focused control
     * into view — clipping the header at the top of the page. Pin
     * the scroll position back to the top on every navigation here.
     * ------------------------------------------------------- */
    _scrollToTop: function () {
      var oPage = this.byId("page");
      setTimeout(function () { oPage.scrollTo(0, 0, 0); }, 0);
    },

    /* ---------------------------------------------------------
     * Change-history timeline — who changed what, and when.
     * Populated from TicketHistory rows the backend writes on
     * every CREATE and on every field the backend detects changed.
     * ------------------------------------------------------- */
    _loadHistory: function (sId) {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      // Ascending (oldest first) so the horizontal step cards read left-to-
      // right as a chronological trail: where it started, then where it went.
      var oBinding = oModel.bindList(
        "/TicketHistory",
        null,
        [new Sorter("createdAt", false)],
        [new Filter("ticket_ticketID", FilterOperator.EQ, sId)]
      );

      oBinding.requestContexts(0, 200).then(function (aContexts) {
        var aList = aContexts.map(function (oCtx) { return oCtx.getObject(); });
        // Flags the first entry so the view can hide its incoming connector
        // (nothing feeds into the very first step of the trail).
        aList.forEach(function (oRow, i) { oRow.__first = (i === 0); });
        that.getView().getModel("hist").setProperty("/list", aList);
      }).catch(function () {
        // History is supplementary — a failed load shouldn't block the page.
      });
    },

    /* ---------------------------------------------------------
     * Attachments already saved against this ticket (uploaded in a
     * previous visit) — without this, the table only ever showed files
     * queued in the current browser session, never what's actually on
     * the server, even though the file's bytes were saved successfully.
     * ------------------------------------------------------- */
    _loadAttachments: function (sId) {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oBinding = oModel.bindList(
        "/Attachments",
        null,
        [new Sorter("createdAt", false)],
        [new Filter("ticket_ticketID", FilterOperator.EQ, sId)]
      );

      var sServiceUrl = oModel.getServiceUrl().replace(/\/$/, "");

      oBinding.requestContexts(0, 200).then(function (aContexts) {
        var aList = aContexts.map(function (oCtx) {
          var oRow = oCtx.getObject();
          return {
            ID: oRow.ID,
            fileName: oRow.fileName,
            category: that._categoryFromFileName(oRow.fileName),
            uploadedBy: oRow.createdBy,
            uploadedOn: that.formatDateTime(oRow.createdAt),
            // Lets the table's file-name Link open/download the actual
            // bytes straight from the media stream — nothing to build
            // server-side, OData already serves it at this URL.
            contentUrl: sServiceUrl + "/Attachments(" + oRow.ID + ")/content"
          };
        });
        that._setAttachmentsList(aList);
      }).catch(function () {
        // Attachments are supplementary — a failed load shouldn't block the page.
      });
    },

    /* ---------------------------------------------------------
     * Edit / Back
     * ------------------------------------------------------- */
    onEdit: function () {
      this._setMode("edit");
    },

    onBack: function () {
      this.onGoDashboard();
    },

    onGoDashboard: function () {
      this.getOwnerComponent().getRouter().navTo("dashboard");
    },

    _bindExistingIncident: function (sId) {
      var oModel = this.getOwnerComponent().getModel();
      var oCtx = oModel.bindContext(
        "/Tickets(ticketID='" + sId + "')",
        null,
        { $$updateGroupId: "incidentGroup" }
      ).getBoundContext();
      this._oIncidentContext = oCtx;
      this.getView().setBindingContext(oCtx);
    },

    /* ---------------------------------------------------------
     * Tabs are in-page navigation — scroll to the matching section
     * instead of swapping content.
     * ------------------------------------------------------- */
    onTabSelect: function (oEvent) {
      var mSections = {
        general: "secGeneral",
        processing: "secProcessing",
        relationships: "secRelationships",
        attachments: "secAttachments",
        history: "secHistory"
      };
      var oSection = this.byId(mSections[oEvent.getParameter("key")]);
      if (oSection) {
        this.byId("page").scrollToElement(oSection.getDomRef(), 400);
      }
    },

    /* =========================================================
     * CASCADING CATEGORIES
     *
     * The hierarchy lives entirely in LookupValue.parent_ID, keyed by the
     * LookupValue row's own ID. What's stored on the ticket (incidentForm.
     * category1..4) is that row's *code* now, not its ID — so each level's
     * cached items carry both: code is what's bound/stored, ID is only
     * used internally to ask "children of this row".
     *
     * Depth is discovered by probing for selCategory1..N controls,
     * so adding a 5th level means adding a 5th Select to the view;
     * no logic here changes.
     * ======================================================= */

    _setupCategories: function () {
      // Discover how many category levels the view declares.
      this._aCatLevels = [];
      for (var i = 1; this.byId("selCategory" + i); i++) {
        this._aCatLevels.push("selCategory" + i);
      }

      // Children are fetched one level at a time and cached by parent id,
      // so the full tree is never loaded and repeat visits cost no requests.
      this._mCatCache = {};

      var aLevels = this._aCatLevels.map(function () {
        return { items: [], enabled: false, busy: false, noChildren: false };
      });
      this.getView().setModel(new JSONModel({ levels: aLevels }), "cat");

      // Level 1 = roots; deeper levels populate from the current record (edit
      // case) or stay disabled until a parent is picked (create case).
      this._loadLevel(0, null).then(this._restoreCategoryChain.bind(this));
    },

    /**
     * Fetch the children of a parent (or the roots when sParentId is null).
     * Cached per parent id.
     */
    _fetchChildren: function (sParentId) {
      var sKey = sParentId || "__root__";
      if (this._mCatCache[sKey]) {
        return Promise.resolve(this._mCatCache[sKey]);
      }

      var aFilters = [new Filter("isActive", FilterOperator.EQ, true)];
      if (sParentId) {
        aFilters.push(new Filter("parent_ID", FilterOperator.EQ, sParentId));
      } else {
        aFilters.push(new Filter("lookupType", FilterOperator.EQ, CAT_ROOT_TYPE));
      }

      var oBinding = this.getOwnerComponent().getModel().bindList(
        "/LookupValues", null, [new Sorter("sequence")], aFilters
      );

      var that = this;
      return oBinding.requestContexts(0, CAT_PAGE_SIZE).then(function (aContexts) {
        var aItems = aContexts.map(function (oCtx) {
          return {
            ID: oCtx.getProperty("ID"),
            code: oCtx.getProperty("code"),
            name: oCtx.getProperty("name")
          };
        });
        that._mCatCache[sKey] = aItems;
        return aItems;
      });
    },

    /**
     * Populate one level with the children of sParentId.
     */
    _loadLevel: function (iLevel, sParentId) {
      if (iLevel >= this._aCatLevels.length) { return Promise.resolve([]); }

      var oCat = this.getView().getModel("cat");
      var sPath = "/levels/" + iLevel + "/";
      oCat.setProperty(sPath + "busy", true);

      var that = this;
      return this._fetchChildren(sParentId).then(function (aItems) {
        oCat.setProperty(sPath + "items", aItems);
        oCat.setProperty(sPath + "enabled", aItems.length > 0);
        // Only tell the user a branch is a dead end once they've chosen a parent.
        oCat.setProperty(sPath + "noChildren", aItems.length === 0 && !!sParentId);
        oCat.setProperty(sPath + "busy", false);
        return aItems;
      }).catch(function (oErr) {
        oCat.setProperty(sPath + "busy", false);
        MessageBox.error("Could not load categories: " + (oErr.message || oErr));
        return [];
      });
    },

    /**
     * Clear every level from iFrom downwards, in both the UI model and the
     * incident record.
     */
    _clearLevelsFrom: function (iFrom) {
      var oCat = this.getView().getModel("cat");
      for (var i = iFrom; i < this._aCatLevels.length; i++) {
        oCat.setProperty("/levels/" + i + "/items", []);
        oCat.setProperty("/levels/" + i + "/enabled", false);
        oCat.setProperty("/levels/" + i + "/noChildren", false);
        oCat.setProperty("/levels/" + i + "/busy", false);
        this._setCategoryValue(i, null);
      }
    },

    _setCategoryValue: function (iLevel, sValue) {
      if (this._oIncidentContext) {
        this._oIncidentContext.setProperty("incidentForm/category" + (iLevel + 1), sValue);
      }
    },

    _getCategoryValue: function (iLevel) {
      return this._oIncidentContext
        ? this._oIncidentContext.getProperty("incidentForm/category" + (iLevel + 1))
        : null;
    },

    /**
     * Given a level's selected *code*, find that row's ID in the level's
     * already-fetched items — that ID is what the next level's children
     * are filtered by (parent_ID), since the hierarchy itself is still
     * keyed on LookupValue IDs.
     */
    _findItemId: function (iLevel, sCode) {
      var aItems = this.getView().getModel("cat").getProperty("/levels/" + iLevel + "/items") || [];
      var oMatch = aItems.filter(function (o) { return o.code === sCode; })[0];
      return oMatch ? oMatch.ID : null;
    },

    /**
     * A parent changed: drop every selection below it, then load the next level.
     */
    onCategoryChange: function (oEvent) {
      var sLocalId = oEvent.getSource().getId().split("--").pop();
      var iLevel = this._aCatLevels.indexOf(sLocalId);
      if (iLevel === -1) { return; }

      var sCode = oEvent.getSource().getSelectedKey();

      // Resetting first guarantees a stale grandchild can never survive.
      this._clearLevelsFrom(iLevel + 1);
      this._setCategoryValue(iLevel, sCode || null);

      if (sCode) {
        this._loadLevel(iLevel + 1, this._findItemId(iLevel, sCode));
      }
    },

    /**
     * Editing an existing record: walk down the saved chain so each level has
     * its options loaded and the stored selections survive.
     */
    _restoreCategoryChain: function () {
      var that = this;
      var iLevel = 0;

      function step() {
        var sCode = that._getCategoryValue(iLevel);
        if (!sCode || iLevel + 1 >= that._aCatLevels.length) {
          return Promise.resolve();
        }
        var sParentId = that._findItemId(iLevel, sCode);
        if (!sParentId) { return Promise.resolve(); }
        return that._loadLevel(iLevel + 1, sParentId).then(function () {
          iLevel++;
          return step();
        });
      }

      return step();
    },

    /* ---------------------------------------------------------
     * Create a transient (pending) OData v4 context, with a nested
     * incidentForm — a deep create, since IncidentForm is a Composition
     * of one on Ticket now (see db/schema.cds). The form binds against
     * this context. On submitBatch the whole aggregate is POSTed to
     * /Tickets in one request.
     * ------------------------------------------------------- */
    _createDraftIncident: function () {
      // Models propagate from the component; the view is not yet attached
      // to the control tree during onInit, so getView().getModel() is undefined here.
      var oModel = this.getOwnerComponent().getModel();
      var oListBinding = oModel.bindList("/Tickets", null, [], [], {
        $$updateGroupId: "incidentGroup"
      });

      // create() returns a transient context — nothing sent to server yet
      this._oIncidentContext = oListBinding.create({
        ticketType: "INCIDENT",
        status: STATUS_DRAFT,  // Draft until Submit moves it to New
        priority: null,
        incidentForm: {
          impact: null,
          urgency: null,
          category1: null,
          category2: null,
          category3: null,
          category4: null,
          solutionCategory: null
        }
      }, true /* bSkipRefresh */);

      // A fresh draft has no number yet — see _getIncidentNumber.
      this._sIncidentNumber = null;

      // Bind the whole page to this transient context
      this.getView().setBindingContext(this._oIncidentContext);
    },

    /* ---------------------------------------------------------
     * ticketNumber, cached at the controller level and reused for the
     * lifetime of this bound context. Nothing in the view binds to
     * "ticketNumber" anymore (the ID field was removed in favor of
     * showing it in the header), so the v4 model never fetches it into
     * its own cache — a plain getProperty() on it silently comes back
     * undefined, including on a *second* save of the same ticket (an
     * UPDATE/PATCH commit doesn't necessarily return a body to refresh
     * it from). The number is assigned once, server-side, at CREATE and
     * never changes afterwards, so fetching it once here and reusing the
     * cached value is both correct and avoids re-depending on the model's
     * cache behaving a particular way on every subsequent save.
     * ------------------------------------------------------- */
    _getIncidentNumber: function () {
      var that = this;
      if (this._sIncidentNumber) {
        return Promise.resolve(this._sIncidentNumber);
      }
      return this._oIncidentContext.requestProperty("ticketNumber").then(function (sNumber) {
        that._sIncidentNumber = sNumber;
        return sNumber;
      });
    },

    /* ---------------------------------------------------------
     * SAVE — persists the incident as a draft (keeps user on page)
     * ------------------------------------------------------- */
    onSave: function () {
      // Guards against a duplicate Incident being created by rapid
      // double/triple-clicks on Save — nothing previously stopped a second
      // click from firing its own submitBatch before the first one's
      // response came back, and each one POSTed a brand new record.
      if (this._bSaving) { return; }
      this._bSaving = true;
      this.getView().getModel("ui").setProperty("/saveEnabled", false);

      var that = this;
      var oModel = this.getView().getModel();

      function releaseSaveGuard() {
        that._bSaving = false;
        that.getView().getModel("ui").setProperty("/saveEnabled", true);
      }

      // Basic client-side check
      var oData = this._oIncidentContext.getObject();
      if (!oData.shortDescription) {
        MessageBox.warning("Short Description is required.");
        releaseSaveGuard();
        return;
      }

      var bEditing = this._sMode === "edit";
      var bWasCreate = this._sMode === "create";

      // Send the batch to the server
      return oModel.submitBatch("incidentGroup").then(function () {
        var sStatus = that._oIncidentContext.getProperty("status");
        var bStillDraft = sStatus === STATUS_DRAFT;

        return that._getIncidentNumber().then(function (sNumber) {
          // Link any pending attachments now that the incident has a key.
          return that._uploadPendingAttachments().then(function () {
            if (bStillDraft) {
              // A Draft is unfinished — stay right here instead of bouncing to
              // the dashboard, and flip the header from "New Ticket" to the
              // real generated number so it's visible without navigating away.
              if (bWasCreate) {
                MessageBox.success("Ticket number " + sNumber + " has been generated.", { title: "Draft Saved" });
              } else {
                MessageToast.show("Ticket " + sNumber + " updated successfully.");
              }
              that._setMode("edit");
            } else {
              MessageToast.show("Ticket " + sNumber + (bEditing ? " updated successfully." : " created successfully."));
              // Back to the dashboard, which refreshes and shows the change.
              that.getOwnerComponent().getRouter().navTo("dashboard");
            }
            releaseSaveGuard();
          });
        });
      }).catch(function (err) {
        MessageBox.error("Save failed: " + (err.message || err));
        releaseSaveGuard();
        throw err;
      });
    },

    /* ---------------------------------------------------------
     * SUBMIT — save whatever's pending, then call the submitTicket()
     * bound action (service.cds), the only door out of Draft. Replaces
     * the old client-side "flip status_ID then Save" — a plain PATCH of
     * status is refused server-side once a ticket is Draft (see
     * srv/handlers/ticket.js onUpdateTicket).
     * ------------------------------------------------------- */
    onSubmit: function () {
      var oData = this._oIncidentContext.getObject();
      var oForm = oData.incidentForm || {};

      var aMissing = [];
      if (!oData.shortDescription) aMissing.push("Short Description");
      if (!oForm.impact)           aMissing.push("Impact");
      if (!oForm.urgency)          aMissing.push("Urgency");
      if (!oData.priority)         aMissing.push("Final Priority");
      if (!oForm.description)      aMissing.push("Full Description");

      if (aMissing.length) {
        MessageBox.warning("Please fill in: " + aMissing.join(", "));
        return;
      }

      var that = this;
      var sNumber = this._sIncidentNumber || oData.ticketNumber || "Ticket";
      MessageBox.confirm(
        "Do you want to submit this ticket?",
        {
          title: "Submit " + sNumber,
          actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
          emphasizedAction: MessageBox.Action.OK,
          onClose: function (sAction) {
            if (sAction !== MessageBox.Action.OK) { return; }
            that._saveThenSubmit();
          }
        }
      );
    },

    _saveThenSubmit: function () {
      var that = this;
      var oModel = this.getView().getModel();

      // onSave() already saves + uploads attachments + shows its own
      // "stayed a Draft" messaging; here we just need the same save
      // pipeline to run first, then move it out of Draft.
      this.onSave().then(function () {
        var oAction = oModel.bindContext("ITSMService.submitTicket(...)", that._oIncidentContext);
        return oAction.execute();
      }).then(function () {
        var sNumber = that._sIncidentNumber || "Ticket";
        MessageToast.show("Ticket " + sNumber + " submitted successfully.");
        that.getOwnerComponent().getRouter().navTo("dashboard");
      }).catch(function (err) {
        MessageBox.error("Submit failed: " + (err.message || err));
      });
    },

    /* ---------------------------------------------------------
     * DELETE — only reachable while the ticket is still a Draft (see
     * showDelete in _setMode); the server enforces the same rule
     * independently (service.js: restrictDeleteToDrafts), so this is a
     * UX convenience, not the actual security boundary.
     * ------------------------------------------------------- */
    onDelete: function () {
      var that = this;
      var sNumber = this._sIncidentNumber || "this draft";

      MessageBox.confirm(
        "Delete " + sNumber + "? This cannot be undone.",
        {
          title: "Delete Ticket",
          actions: [MessageBox.Action.DELETE, MessageBox.Action.CANCEL],
          emphasizedAction: MessageBox.Action.DELETE,
          onClose: function (sAction) {
            if (sAction !== MessageBox.Action.DELETE) { return; }
            that._oIncidentContext.delete("incidentGroup").then(function () {
              MessageToast.show("Draft deleted.");
              that.getOwnerComponent().getRouter().navTo("dashboard");
            }).catch(function (err) {
              MessageBox.error("Delete failed: " + (err.message || err));
            });
            // "incidentGroup" is an API-mode group (see onSave) — queuing
            // the delete above doesn't send it; submitBatch is what
            // actually fires the DELETE request.
            that.getView().getModel().submitBatch("incidentGroup");
          }
        }
      );
    },

    /* ---------------------------------------------------------
     * Attachments list + "Attachments: N" counter live together so
     * the label never drifts out of sync with the table.
     * ------------------------------------------------------- */
    _setAttachmentsList: function (aList) {
      var oAttModel = this.getView().getModel("attachments");
      oAttModel.setProperty("/list", aList);
      oAttModel.setProperty("/countLabel", "Attachments: " + aList.length);
    },

    // No "category" field on the Attachment entity — the file's own
    // extension stands in for it, same idea as the type note above the table.
    _categoryFromFileName: function (sFileName) {
      var iDot = sFileName.lastIndexOf(".");
      return iDot > -1 ? sFileName.slice(iDot + 1).toUpperCase() : "FILE";
    },

    /* ---------------------------------------------------------
     * File selection — queue locally (upload after incident save)
     * ------------------------------------------------------- */
    onFileSelected: function (oEvent) {
      var aFiles = oEvent.getParameter("files");
      if (!aFiles || !aFiles.length) { return; }

      var aList = this.getView().getModel("attachments").getProperty("/list");
      var sNow = new Date().toLocaleString();

      Array.prototype.forEach.call(aFiles, function (file) {
        aList.push({
          fileName: file.name,
          originalName: file.name,
          mimeType: file.type,
          fileSize: file.size,
          category: this._categoryFromFileName(file.name),
          uploadedBy: "You",
          uploadedOn: sNow,
          _fileObject: file            // kept only in memory
        });
      }, this);

      this._setAttachmentsList(aList);
      oEvent.getSource().clear(); // let the same file be picked again later
      MessageToast.show(aFiles.length + " file(s) queued");
    },

    /* ---------------------------------------------------------
     * Action column — drop a queued (not yet uploaded) attachment.
     * ------------------------------------------------------- */
    onAttachmentRemove: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("attachments");
      var aList = this.getView().getModel("attachments").getProperty("/list");
      var iIndex = aList.indexOf(oCtx.getObject());
      if (iIndex > -1) {
        aList.splice(iIndex, 1);
        this._setAttachmentsList(aList);
      }
    },

    /* ---------------------------------------------------------
     * After the incident is persisted, create an Attachment record
     * (metadata) for each queued file, then stream the file's actual
     * bytes into its "content" media property (a LargeBinary column —
     * the file itself lives in the database, not just a path to it).
     * The metadata rows need real IDs from the server before the byte
     * stream can be PUT to /Attachments(ID)/content, so that part runs
     * only after the metadata batch has come back.
     * ------------------------------------------------------- */
    _uploadPendingAttachments: function () {
      var that = this;
      var oAttModel = this.getView().getModel("attachments");
      var aList = oAttModel.getProperty("/list") || [];

      // Only genuinely new, not-yet-uploaded files — the list also holds
      // attachments already persisted in an earlier save (reloaded via
      // _loadAttachments so they stay visible), which have a real ID and
      // no _fileObject. Without this filter, every repeat Save on the same
      // ticket re-created a brand new Attachment row for those too, so the
      // same file ended up duplicated once per Save click.
      var aPending = aList.filter(function (f) { return f._fileObject && !f.ID; });
      if (!aPending.length) { return Promise.resolve(); }

      var sTicketID = this._oIncidentContext.getProperty("ticketID");
      if (!sTicketID) { return Promise.resolve(); }

      var oModel = this.getView().getModel();
      var oAttBinding = oModel.bindList("/Attachments", null, [], [], {
        $$updateGroupId: "incidentGroup"
      });

      var aContexts = aPending.map(function (f) {
        return oAttBinding.create({
          ticket_ticketID: sTicketID,
          fileName: f.fileName,
          originalName: f.originalName,
          mimeType: f.mimeType,
          fileSize: f.fileSize
        });
      });

      return oModel.submitBatch("incidentGroup").then(function () {
        // sap.ui.model.odata.v4.ODataModel has no high-level API for
        // writing a stream property, so each file's bytes go straight to
        // the service with a plain PUT — reusing the model's own headers
        // (CSRF token, etc.) so it goes through the same auth as every
        // other request this session makes.
        var sServiceUrl = oModel.getServiceUrl().replace(/\/$/, "");
        var mHeaders = oModel.getHttpHeaders();

        return Promise.all(aContexts.map(function (oCtx, i) {
          var oFile = aPending[i]._fileObject;
          var sAttId = oCtx.getProperty("ID");
          return fetch(sServiceUrl + "/Attachments(" + sAttId + ")/content", {
            method: "PUT",
            headers: Object.assign({}, mHeaders, {
              "Content-Type": aPending[i].mimeType || "application/octet-stream"
            }),
            body: oFile
          }).then(function (oResponse) {
            if (!oResponse.ok) {
              throw new Error(aPending[i].fileName + ": upload failed (" + oResponse.status + ")");
            }
          });
        }));
      }).then(function () {
        // Re-fetch from the server instead of just clearing to [] — the
        // files just uploaded should stay visible (with real, clickable
        // content links) instead of vanishing until the ticket is reopened.
        that._loadAttachments(sTicketID);
        MessageToast.show("Attachments uploaded");
      });
    },

    /* ---------------------------------------------------------
     * History timeline formatters. TicketHistory rows carry the raw
     * field name (fieldName) rather than a pre-resolved label — the
     * "Ticket Created" special-case is inferred from the specific shape
     * the backend's afterCreateTicket hook logs (status: null -> DRAFT),
     * since there's no separate changeType column in the new schema.
     * ------------------------------------------------------- */
    formatHistoryIcon: function (sFieldName, sOldValue) {
      return (sFieldName === "status" && !sOldValue) ? "sap-icon://add-document" : "sap-icon://edit";
    },

    formatHistoryTitle: function (sFieldName, sOldValue) {
      return (sFieldName === "status" && !sOldValue) ? "Ticket Created" : "Ticket Updated";
    },

    formatHistoryText: function (sFieldName, sOld, sNew) {
      if (sFieldName === "status" && !sOld) { return "Ticket record was created."; }
      var sLabel = HISTORY_FIELD_LABELS[sFieldName] || sFieldName;
      if (!sOld) { return sLabel + ' set to "' + sNew + '".'; }
      return sLabel + ' changed from "' + sOld + '" to "' + sNew + '".';
    },

    // OData v4 delivers timestamps as ISO strings; format them for display.
    formatDateTime: function (sValue) {
      if (!sValue) { return ""; }
      var oDate = new Date(sValue);
      return isNaN(oDate.getTime()) ? "" : oDate.toLocaleString();
    },

    /* ---------------------------------------------------------
     * SLA badge — response clock runs from createdAt until
     * firstResponseAt is stamped (ticket leaves New); resolution
     * clock runs from createdAt until completedAt is stamped
     * (Confirmed/Closed). Both stamped server-side, see
     * srv/handlers/ticket.js stampSlaTimestamps.
     * ------------------------------------------------------- */
    formatSlaState: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      return this._computeSla(sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt).state;
    },

    formatSlaText: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      return this._computeSla(sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt).text;
    },

    _computeSla: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
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
        if (iLeft < 0) { return { state: "Error", text: "Response Overdue" }; }
        if (iLeft < oWindow.response * HOUR * 0.25) { return { state: "Warning", text: "Response Due Soon" }; }
        return { state: "Success", text: "On Track" };
      }

      var iResolveBy2 = iCreated + oWindow.resolution * HOUR;
      var iLeft2 = iResolveBy2 - iNow;
      if (iLeft2 < 0) { return { state: "Error", text: "Resolution Overdue" }; }
      if (iLeft2 < oWindow.resolution * HOUR * 0.25) { return { state: "Warning", text: "Due Soon" }; }
      return { state: "Success", text: "On Track" };
    }

  });
});
