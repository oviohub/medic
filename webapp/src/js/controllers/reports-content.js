var _ = require('underscore');

(function () {

  'use strict';

  angular.module('inboxControllers').controller('ReportsContentCtrl',
    function (
      $log,
      $ngRedux,
      $scope,
      $stateParams,
      $timeout,
      Changes,
      GlobalActions,
      MessageState,
      Selectors
    ) {

      'ngInject';

      var ctrl = this;
      var mapStateToTarget = function(state) {
        return {
          loadingContent: Selectors.getLoadingContent(state),
          selectMode: Selectors.getSelectMode(state),
          selected: Selectors.getSelected(state),
          summaries: Selectors.getSelectedSummaries(state),
          validChecks: Selectors.getSelectedValidChecks(state)
        };
      };
      var mapDispatchToTarget = function(dispatch) {
        var globalActions = GlobalActions(dispatch);
        return {
          clearCancelCallback: globalActions.clearCancelCallback,
          setSelected: globalActions.setSelected,
          updateSelectedItem: globalActions.updateSelectedItem,
          setFirstSelectedFormattedProperty: globalActions.setFirstSelectedFormattedProperty
        };
      };
      var unsubscribe = $ngRedux.connect(mapStateToTarget, mapDispatchToTarget)(ctrl);

      $scope.selectReport($stateParams.id);
      ctrl.clearCancelCallback();
      $('.tooltip').remove();

      $scope.canMute = function(group) {
        return MessageState.any(group, 'scheduled');
      };

      $scope.canSchedule = function(group) {
       return MessageState.any(group, 'muted');
      };

      var setMessageState = function(report, group, from, to) {
        group.loading = true;
        var id = report._id;
        var groupNumber = group.rows[0].group;
        MessageState.set(id, groupNumber, from, to).catch(function(err) {
          group.loading = false;
          $log.error('Error setting message state', err);
        });
      };

      $scope.mute = function(report, group) {
        setMessageState(report, group, 'scheduled', 'muted');
      };

      $scope.schedule = function(report, group) {
        setMessageState(report, group, 'muted', 'scheduled');
      };

      $scope.toggleExpand = function(selection) {
        if (!ctrl.selectMode) {
          return;
        }

        var id = selection._id;
        if (selection.report || selection.expanded) {
          ctrl.updateSelectedItem(id, { expanded: !selection.expanded });
        } else {
          ctrl.updateSelectedItem(id, { loading: true });
          $scope.refreshReportSilently(id)
            .then(function() {
              ctrl.updateSelectedItem(id, { loading: false, expanded: true });
            })
            .catch(function(err) {
              ctrl.updateSelectedItem(id, { loading: false });
              $log.error('Error fetching doc for expansion', err);
            });
        }
      };

      $scope.deselect = function(report, $event) {
        if (ctrl.selectMode) {
          $event.stopPropagation();
          $scope.deselectReport(report);
        }
      };

      $scope.labelIsIDorName = (label) => {
        return label.endsWith('.patient_id') || label.endsWith('.patient_uuid') || label.endsWith('.patient_name');
      };

      var changeListener = Changes({
        key: 'reports-content',
        filter: function(change) {
          return ctrl.selected &&
            ctrl.selected.length &&
            _.some(ctrl.selected, function(item) {
              return item._id === change.id;
            });
        },
        callback: function(change) {
          if (change.deleted) {
            $scope.$apply(function() {
              $scope.deselectReport(change.doc);
            });
          } else {
            var selected = ctrl.selected;
            $scope.refreshReportSilently(change.doc)
              .then(function() {
                if(selected[0].formatted.verified !== change.doc.verified ||
                   ('oldVerified' in selected[0].formatted &&
                    selected[0].formatted.oldVerified !== change.doc.verified)) {
                  ctrl.setSelected(selected);
                  $timeout(function() {
                    ctrl.setFirstSelectedFormattedProperty({ verified: change.doc.verified });
                  });
                }
              });
          }
        }
      });

      $scope.$on('$destroy', function() {
        unsubscribe();
        changeListener.unsubscribe();
      });

      $scope.$on('VerifiedReport', function(e, valid) {
        var oldVerified = ctrl.selected[0].formatted.verified;
        var newVerified = oldVerified === valid ? undefined : valid;

        ctrl.setFirstSelectedFormattedProperty({ verified: newVerified, oldVerified: oldVerified });

        $scope.setSubActionBarStatus(newVerified);
      });
    }
  );

}());
