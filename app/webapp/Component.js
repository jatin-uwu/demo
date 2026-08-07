sap.ui.define([
  "sap/ui/core/UIComponent"
], function (UIComponent) {
  "use strict";

  // Routes that belong to the Consultant module vs. everything else. A
  // Consultant is a distinct, isolated identity (see xs-security.json —
  // its role-template carries no Agent/ServiceGroup scope): logging in as
  // one must open straight into Assigned Tickets and never bounce through
  // the shared End User / Service Group dashboard, and vice versa. This is
  // the single choke point for that rule — every route match (including a
  // manually typed hash) is checked against it before the target view ever
  // mounts, and the redirect never adds a history entry, so Back can't step
  // back into the wrong module either.
  var CONSULTANT_ROUTES = ["assigned", "assignedDetail"];
  var OTHER_ROUTES = ["dashboard", "analytics", "create", "detail"];

  return UIComponent.extend("itsm.ui.Component", {
    metadata: { manifest: "json" },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
<<<<<<< HEAD
      this.getRouter().initialize();
      this._applyRoleBasedLanding();
    },

    /**
     * Role-based default landing. Service Group / Admin users who open the
     * app at the default (End User) landing are sent to their own analytics
     * dashboard instead. Runs once, at startup, and only when the app opened
     * on the default route — so deep links and any later navigation back to
     * the ticket table (e.g. via "View Tickets") are never hijacked.
     *
     * The End User (Agent) flow is untouched: their hash resolves normally
     * and this redirect never fires for them.
     */
    _applyRoleBasedLanding: function () {
      var oRouter = this.getRouter();
      var oModel = this.getModel();
      if (!oModel) { return; }

      // Only act on the default landing; leave every explicit route alone.
      if (oRouter.getHashChanger().getHash()) { return; }

      var oCtx = oModel.bindContext("/currentUser(...)");
      oCtx.execute().then(function () {
        var oUser = oCtx.getBoundContext();
        var bServiceGroup = !!(oUser.getProperty("isServiceGroup") || oUser.getProperty("isAdmin"));
        // Still on the default landing when the role came back? Send them on.
        if (bServiceGroup && !oRouter.getHashChanger().getHash()) {
          oRouter.navTo("serviceGroupDashboard");
        }
      }).catch(function () { /* best-effort — fall back to the default landing */ });
=======

      var oRouter = this.getRouter();
      var that = this;

      this._fetchCurrentUser().then(function (bIsConsultant) {
        that._bIsConsultant = bIsConsultant;
        that._guardRoutes(oRouter);
        oRouter.initialize();
      });
    },

    /**
     * Resolved once at startup — role membership doesn't change mid-session,
     * so every route match for the rest of the session reuses this instead
     * of re-fetching it.
     */
    _fetchCurrentUser: function () {
      var oModel = this.getModel();
      var oAction = oModel.bindContext("/currentUser(...)");
      return oAction.execute().then(function () {
        return !!oAction.getBoundContext().getProperty("isConsultant");
      }).catch(function () {
        // Best-effort: if identity can't be resolved, fall back to the
        // non-Consultant experience rather than blocking the app entirely.
        return false;
      });
    },

    _guardRoutes: function (oRouter) {
      var that = this;
      var aGuarded = this._bIsConsultant ? OTHER_ROUTES : CONSULTANT_ROUTES;
      var sHome = this._bIsConsultant ? "assigned" : "dashboard";

      aGuarded.forEach(function (sRouteName) {
        var oRoute = oRouter.getRoute(sRouteName);
        if (!oRoute) { return; }
        oRoute.attachPatternMatched(function () {
          oRouter.navTo(sHome, {}, true /* no history entry */);
        });
      });
>>>>>>> afb046b4ea3cf8c98210405bf7358b0ba2aed201
    }
  });
});
