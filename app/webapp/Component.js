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
    }
  });
});
