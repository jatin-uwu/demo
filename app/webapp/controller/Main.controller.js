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

  return Controller.extend("itsm.ui.controller.Main", {

    /* ---------------------------------------------------------
     * Lifecycle
     * ------------------------------------------------------- */
    onInit: function () {
      // Local model for pending attachments (before incident is saved)
      this.getView().setModel(new JSONModel({ list: [] }), "attachments");

      // Drives header buttons and form editability by mode.
      this.getView().setModel(new JSONModel({}), "ui");

      // The form is shared by two routes: "create" (new draft) and
      // "detail" (view an existing ticket). The view is cached and reused, so
      // the per-visit setup lives in the route-matched handlers, not onInit.
      var oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("create").attachPatternMatched(this._onCreateMatched, this);
      oRouter.getRoute("detail").attachPatternMatched(this._onDetailMatched, this);
    },

    /**
     * Switch the form between "create", "view" and "edit". Everything the
     * header and fields react to lives in the "ui" model, so the view stays
     * declarative.
     */
    _setMode: function (sMode) {
      this._sMode = sMode;
      var sNumber = this._oIncidentContext
        ? this._oIncidentContext.getProperty("incidentNumber")
        : null;

      var mModes = {
        create: {
          title: "New Ticket",
          subtitle: "Creating New Service Request Record",
          formEditable: true,
          showBack: true, showEdit: false, showSave: true, showSubmit: true
        },
        view: {
          title: sNumber || "Ticket",
          subtitle: "Viewing service request",
          formEditable: false,
          showBack: true, showEdit: true, showSave: false, showSubmit: false
        },
        edit: {
          title: sNumber || "Ticket",
          subtitle: "Editing service request",
          formEditable: true,
          showBack: true, showEdit: false, showSave: true, showSubmit: false
        }
      };
      this.getView().getModel("ui").setData(mModes[sMode]);
    },

    /* ---------------------------------------------------------
     * Route: create — fresh draft each time.
     * ------------------------------------------------------- */
    _onCreateMatched: function () {
      this.getView().getModel("attachments").setProperty("/list", []);
      this._createDraftIncident();
      this._setMode("create");
      this._setupCategories();
      this._previewIncidentNumber();
    },

    /* ---------------------------------------------------------
     * Route: detail — bind an existing ticket, read-only to start.
     * ------------------------------------------------------- */
    _onDetailMatched: function (oEvent) {
      var that = this;
      this.getView().getModel("attachments").setProperty("/list", []);
      this._bindExistingIncident(oEvent.getParameter("arguments").id);
      this._setMode("view");
      // The number/title arrives with the record; refresh the header once loaded.
      this._oIncidentContext.requestProperty("incidentNumber").then(function (sNo) {
        that.getView().getModel("ui").setProperty("/title", sNo || "Ticket");
      }).catch(function () { /* ignore */ });
      this._setupCategories();
    },

    /* ---------------------------------------------------------
     * Edit / Back
     * ------------------------------------------------------- */
    onEdit: function () {
      this._setMode("edit");
    },

    onBack: function () {
      this.getOwnerComponent().getRouter().navTo("list");
    },

    /* ---------------------------------------------------------
     * Ask the backend for the next number and show it read-only.
     * The backend re-assigns the authoritative value on save, so a
     * stale preview can never cause a duplicate.
     * ------------------------------------------------------- */
    _previewIncidentNumber: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oCtx = oModel.bindContext("/nextIncidentNumber(...)");
      oCtx.execute().then(function () {
        var sNext = oCtx.getBoundContext().getProperty("value");
        if (sNext && that._oIncidentContext) {
          that._oIncidentContext.setProperty("incidentNumber", sNext);
        }
      }).catch(function () {
        /* preview only — ignore, backend still assigns on save */
      });
    },

    _bindExistingIncident: function (sId) {
      var oModel = this.getOwnerComponent().getModel();
      var oCtx = oModel.bindContext(
        "/Incident(" + sId + ")",
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
        details: "secDetails",
        description: "secDescription",
        attachments: "secAttachments"
      };
      var oSection = this.byId(mSections[oEvent.getParameter("key")]);
      if (oSection) {
        this.byId("page").scrollToElement(oSection.getDomRef(), 400);
      }
    },

    /* =========================================================
     * CASCADING CATEGORIES
     *
     * The hierarchy lives entirely in LookupValue.parent_ID. This
     * controller never hardcodes which values belong to which
     * parent — it only ever asks the service for "children of X".
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
        "/Lookup", null, [new Sorter("sequence")], aFilters
      );

      var that = this;
      return oBinding.requestContexts(0, CAT_PAGE_SIZE).then(function (aContexts) {
        var aItems = aContexts.map(function (oCtx) {
          return { ID: oCtx.getProperty("ID"), name: oCtx.getProperty("name") };
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
        this._oIncidentContext.setProperty("category" + (iLevel + 1) + "_ID", sValue);
      }
    },

    _getCategoryValue: function (iLevel) {
      return this._oIncidentContext
        ? this._oIncidentContext.getProperty("category" + (iLevel + 1) + "_ID")
        : null;
    },

    /**
     * A parent changed: drop every selection below it, then load the next level.
     */
    onCategoryChange: function (oEvent) {
      var sLocalId = oEvent.getSource().getId().split("--").pop();
      var iLevel = this._aCatLevels.indexOf(sLocalId);
      if (iLevel === -1) { return; }

      var sKey = oEvent.getSource().getSelectedKey();

      // Resetting first guarantees a stale grandchild can never survive.
      this._clearLevelsFrom(iLevel + 1);
      this._setCategoryValue(iLevel, sKey || null);

      if (sKey) {
        this._loadLevel(iLevel + 1, sKey);
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
        var sValue = that._getCategoryValue(iLevel);
        if (!sValue || iLevel + 1 >= that._aCatLevels.length) {
          return Promise.resolve();
        }
        return that._loadLevel(iLevel + 1, sValue).then(function () {
          iLevel++;
          return step();
        });
      }

      return step();
    },

    /* ---------------------------------------------------------
     * Create a transient (pending) OData v4 context
     * The form binds against this context. On submitBatch the
     * record is POSTed to /Incident.
     * ------------------------------------------------------- */
    _createDraftIncident: function () {
      // Models propagate from the component; the view is not yet attached
      // to the control tree during onInit, so getView().getModel() is undefined here.
      var oModel = this.getOwnerComponent().getModel();
      var oListBinding = oModel.bindList("/Incident", null, [], [], {
        $$updateGroupId: "incidentGroup"
      });

      // create() returns a transient context — nothing sent to server yet
      this._oIncidentContext = oListBinding.create({
        status_ID: null,
        impact_ID: null,
        urgency_ID: null,
        priority_ID: null,
        category1_ID: null,
        category2_ID: null,
        category3_ID: null,
        category4_ID: null,
        solutionCategory_ID: null
      }, true /* bSkipRefresh */);

      // Bind the whole page to this transient context
      this.getView().setBindingContext(this._oIncidentContext);
    },

    /* ---------------------------------------------------------
     * SAVE — persists the incident as a draft (keeps user on page)
     * ------------------------------------------------------- */
    onSave: function () {
      var that = this;
      var oModel = this.getView().getModel();

      // Basic client-side check
      var oData = this._oIncidentContext.getObject();
      if (!oData.shortDescription) {
        MessageBox.warning("Short Description is required.");
        return;
      }

      var bEditing = this._sMode === "edit";

      // Send the batch to the server
      oModel.submitBatch("incidentGroup").then(function () {
        // On CREATE the backend assigned the authoritative incident number.
        var sNumber = that._oIncidentContext.getProperty("incidentNumber");

        // Link any pending attachments now that the incident has a key.
        return that._uploadPendingAttachments().then(function () {
          MessageToast.show("Ticket " + sNumber + (bEditing ? " updated successfully." : " created successfully."));
          // Back to the list, which refreshes and shows the change.
          that.getOwnerComponent().getRouter().navTo("list");
        });
      }).catch(function (err) {
        MessageBox.error("Save failed: " + (err.message || err));
      });
    },

    /* ---------------------------------------------------------
     * SUBMIT — same as save but also validates required fields
     * ------------------------------------------------------- */
    onSubmit: function () {
      var oData = this._oIncidentContext.getObject();

      var aMissing = [];
      if (!oData.shortDescription)  aMissing.push("Short Description");
      if (!oData.impact_ID)         aMissing.push("Impact");
      if (!oData.urgency_ID)        aMissing.push("Urgency");
      if (!oData.priority_ID)       aMissing.push("Final Priority");
      if (!oData.description)       aMissing.push("Full Description");

      if (aMissing.length) {
        MessageBox.warning("Please fill in: " + aMissing.join(", "));
        return;
      }

      this.onSave();
    },

    /* ---------------------------------------------------------
     * File selection — queue locally (upload after incident save)
     * ------------------------------------------------------- */
    onFileSelected: function (oEvent) {
      var aFiles = oEvent.getParameter("files");
      if (!aFiles || !aFiles.length) { return; }

      var oAttModel = this.getView().getModel("attachments");
      var aList = oAttModel.getProperty("/list");

      Array.prototype.forEach.call(aFiles, function (file) {
        aList.push({
          fileName: file.name,
          originalName: file.name,
          mimeType: file.type,
          fileSize: file.size,
          _fileObject: file            // kept only in memory
        });
      });

      oAttModel.setProperty("/list", aList);
      MessageToast.show(aFiles.length + " file(s) queued");
    },

    /* ---------------------------------------------------------
     * After the incident is persisted, create an Attachment
     * record for each queued file (metadata only — matches your
     * schema which stores storagePath, not binary).
     *
     * If you later add a real upload endpoint, POST the binary
     * there first and store the returned URL in storagePath.
     * ------------------------------------------------------- */
    _uploadPendingAttachments: function () {
      var oAttModel = this.getView().getModel("attachments");
      var aList = oAttModel.getProperty("/list") || [];
      if (!aList.length) { return Promise.resolve(); }

      var sIncidentID = this._oIncidentContext.getProperty("ID");
      if (!sIncidentID) { return Promise.resolve(); }

      var oModel = this.getView().getModel();
      var oAttBinding = oModel.bindList("/Attachment", null, [], [], {
        $$updateGroupId: "incidentGroup"
      });

      aList.forEach(function (f) {
        oAttBinding.create({
          incident_ID: sIncidentID,
          fileName: f.fileName,
          originalName: f.originalName,
          mimeType: f.mimeType,
          fileSize: f.fileSize,
          storagePath: "/uploads/" + f.fileName  // placeholder
        });
      });

      return oModel.submitBatch("incidentGroup").then(function () {
        oAttModel.setProperty("/list", []);
        MessageToast.show("Attachments linked");
      });
    }

  });
});
