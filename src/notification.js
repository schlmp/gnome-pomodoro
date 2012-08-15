// A simple pomodoro timer for Gnome-shell
// Copyright (C) 2011,2012 Gnome-shell pomodoro extension contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;

const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Pango = imports.gi.Pango;

const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const ModalDialog = imports.ui.modalDialog;
const ScreenSaver = imports.misc.screenSaver;
const Tweener = imports.ui.tweener;
const ExtensionUtils = imports.misc.extensionUtils;

const Extension = imports.misc.extensionUtils.getCurrentExtension();
const PomodoroUtil = Extension.imports.util;

const Gettext = imports.gettext.domain('gnome-shell-pomodoro');
const _ = Gettext.gettext;
const ngettext = Gettext.ngettext;


// Notification dialog blocks user input for a time corresponding to slow typing speed
// of 23 words per minute which translates to 523 miliseconds between key presses,
// and moderate typing speed of 35 words per minute / 343 miliseconds.
// Pressing Enter key takes longer, so more time needed.
const BLOCK_EVENTS_TIME = 600;
// Time after which stop trying to open a dialog and open a notification
const FALLBACK_TIME = 1000;
// Rate per second at which try opening a dialog
const FALLBACK_RATE = Clutter.get_default_frame_rate();

// Time to open notification dialog
const IDLE_TIME_TO_OPEN = 60000;
// Time to determine activity after which notification dialog is closed
const IDLE_TIME_TO_CLOSE = 600;
// Time before user activity is being monitored
const MIN_DISPLAY_TIME = 1000;
// Time to fade-in or fade-out notification
const OPEN_AND_CLOSE_TIME = 0.2;
// Time to fade-in or fade-out notification content without lightbox
const FADE_OUT_DIALOG_TIME = 1.0;

const State = {
    OPENED: 0,
    CLOSED: 1,
    OPENING: 2,
    CLOSING: 3,
    FADED_OUT: 4
};


const NotificationSource = new Lang.Class({
    Name: 'PomodoroNotificationSource',
    Extends: MessageTray.Source,

    _init: function() {
        this.parent(_("Pomodoro Timer"));
        
        this._setSummaryIcon(this.createNotificationIcon());
    },

    createNotificationIcon: function() {
        let iconTheme = Gtk.IconTheme.get_default();

        if (!iconTheme.has_icon('timer'))
            iconTheme.append_search_path (PomodoroUtil.getExtensionPath());

        return new St.Icon({ icon_name: 'timer',
                             icon_type: St.IconType.SYMBOLIC,
                             icon_size: this.ICON_SIZE });
    },

    open: function(notification) {
        this.destroyNonResidentNotifications();
    }
});

// LightboxDialog class is based on ModalDialog from GNOME Shell
const LightboxDialog = new Lang.Class({
    Name: 'PomodoroLightboxDialog',

    _init: function() {
        this.state = State.CLOSED;
        this._hasModal = false;

        this._group = new St.Widget({ visible: false,
                                      x: 0,
                                      y: 0,
                                      accessible_role: Atk.Role.DIALOG });
        Main.uiGroup.add_actor(this._group);

        let constraint = new Clutter.BindConstraint({ source: global.stage,
                                                      coordinate: Clutter.BindCoordinate.ALL });
        this._group.add_constraint(constraint);
        this._group.connect('destroy', Lang.bind(this, this._onGroupDestroy));

        this._backgroundBin = new St.Bin();
        this._group.add_actor(this._backgroundBin);

        this._dialogLayout = new St.BoxLayout({ style_class: 'extension-pomodoro-dialog',
                                                vertical:    true });

        this._lightbox = new Lightbox.Lightbox(this._group,
                                               { inhibitEvents: false });
        this._lightbox.highlight(this._backgroundBin);
        this._lightbox.actor.style_class = 'extension-pomodoro-lightbox';

        this._backgroundBin.child = this._dialogLayout;

        this.contentLayout = new St.BoxLayout({ vertical: true });
        this._dialogLayout.add(this.contentLayout,
                               { x_fill:  true,
                                 y_fill:  true,
                                 x_align: St.Align.MIDDLE,
                                 y_align: St.Align.START });
    },

    destroy: function() {
        this._group.destroy();
    },

    _onGroupDestroy: function() {
        this.emit('destroy');
    },

    _fadeOpen: function() {
        let monitor = Main.layoutManager.focusMonitor;

        this._backgroundBin.set_position(monitor.x, monitor.y);
        this._backgroundBin.set_size(monitor.width, monitor.height);

        this.state = State.OPENING;

        this._dialogLayout.opacity = 255;
        if (this._lightbox)
            this._lightbox.show();
        this._group.opacity = 0;
        this._group.show();
        Tweener.addTween(this._group,
                         { opacity: 255,
                           time: OPEN_AND_CLOSE_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this,
                               function() {
                                   this.state = State.OPENED;
                                   this.emit('opened');
                               })
                         });
    },

    open: function(timestamp) {
        if (this.state == State.OPENED || this.state == State.OPENING)
            return true;

        if (!this.pushModal(timestamp))
            return false;

        this._fadeOpen();
        return true;
    },

    close: function(timestamp) {
        if (this.state == State.CLOSED || this.state == State.CLOSING)
            return;

        this.state = State.CLOSING;
        this.popModal(timestamp);

        Tweener.addTween(this._group,
                         { opacity: 0,
                           time: OPEN_AND_CLOSE_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this,
                               function() {
                                   this.state = State.CLOSED;
                                   this._group.hide();
                               })
                         });
    },

    // Drop modal status without closing the dialog; this makes the
    // dialog insensitive as well, so it needs to be followed shortly
    // by either a close() or a pushModal()
    popModal: function(timestamp) {
        if (!this._hasModal)
            return;

        Main.popModal(this._group, timestamp);
        global.gdk_screen.get_display().sync();
        this._hasModal = false;
    },

    pushModal: function (timestamp) {
        if (this._hasModal)
            return true;
        if (!Main.pushModal(this._group, timestamp))
            return false;

        this._hasModal = true;

        return true;
    },

    // This method is like close, but fades the dialog out much slower,
    // and leaves the lightbox in place. Once in the faded out state,
    // the dialog can be brought back by an open call, or the lightbox
    // can be dismissed by a close call.
    //
    // The main point of this method is to give some indication to the user
    // that the dialog reponse has been acknowledged but will take a few
    // moments before being processed.
    // e.g., if a user clicked "Log Out" then the dialog should go away
    // imediately, but the lightbox should remain until the logout is
    // complete.
    _fadeOutDialog: function(timestamp) {
        if (this.state == State.CLOSED || this.state == State.CLOSING)
            return;

        if (this.state == State.FADED_OUT)
            return;

        this.popModal(timestamp);
        Tweener.addTween(this._dialogLayout,
                         { opacity: 0,
                           time:    FADE_OUT_DIALOG_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this,
                               function() {
                                   this.state = State.FADED_OUT;
                               })
                         });
    }
});
Signals.addSignalMethods(LightboxDialog.prototype);


const NotificationDialog = new Lang.Class({
    Name: 'PomodoroNotificationDialog',
    Extends: LightboxDialog,

    _init: function() {
        this.parent();
        
        this._timer = '';
        this._description = '';
        this._notificationTitle = '';
        this._notificationDescription = '';
        
        this._timeoutSource = 0;
        this._notification = null;
        this._notificationButtons = [];
        this._notificationSource = null;
        this._eventCaptureSource = 0;
        this._eventCaptureId = 0;
        this._screenSaver = null;
        this._screenSaverChangedId = 0;
        
        this._idleMonitor = new Shell.IdleMonitor();
        this._idleMonitorWatchId = 0;
        
        let mainLayout = new St.BoxLayout({ style_class: 'extension-pomodoro-dialog-main-layout',
                                            vertical: false });
        
        let messageBox = new St.BoxLayout({ style_class: 'extension-pomodoro-dialog-message-layout',
                                            vertical: true });
        
        this._timerLabel = new St.Label({ style_class: 'extension-pomodoro-dialog-timer',
                                          text: '' });
        
        this._descriptionLabel = new St.Label({ style_class: 'extension-pomodoro-dialog-description',
                                                text: '' });
        this._descriptionLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._descriptionLabel.clutter_text.line_wrap = true;
        
        messageBox.add(this._timerLabel,
                            { y_fill:  false,
                              y_align: St.Align.START });
        messageBox.add(this._descriptionLabel,
                            { y_fill:  true,
                              y_align: St.Align.START });
        mainLayout.add(messageBox,
                            { x_fill: true,
                              y_align: St.Align.START });
        this.contentLayout.add(mainLayout,
                            { x_fill: true,
                              y_fill: true });
        
        this.connect('opened', Lang.bind(this, function() {
                // Close notification once dialog successfully opens
                this._closeNotification();
            }));
    },

    open: function(timestamp) {
        if (ModalDialog.ModalDialog.prototype.open.call(this, timestamp)) {
            this._closeNotification();
            this._disconnectInternals();
            this._enableEventCapture();
            
            Mainloop.timeout_add(MIN_DISPLAY_TIME, Lang.bind(this, function(){
                    this._closeWhenActive();
                    return false;
                }));
            
            return true; // dialog already opened
        }
        
        if (!this._screenSaver)
            this._screenSaver = new ScreenSaver.ScreenSaverProxy();
        
        if (this._screenSaver.screenSaverActive) {
            if (this._screenSaverChangedId == 0)
                this._screenSaverChangedId = this._screenSaver.connectSignal(
                                                           'ActiveChanged',
                                                           Lang.bind(this, this._onScreenSaverChanged));
        }
        else {
            if (this._timeoutSource == 0) {
                this._tries = 1;
                this._timeoutSource = Mainloop.timeout_add(parseInt(1000/FALLBACK_RATE),
                                                           Lang.bind(this, this._onTimeout));
            }
        }
        return false;
    },

    close: function(timestamp) {
        this._disconnectInternals();
        this._openNotification();

        let result = ModalDialog.ModalDialog.prototype.close.call(this, timestamp);

        this._openWhenIdle();

        // ModalDialog only emits 'opened' signal, so we need to do that
        this.emit('closed'); 

        return result;
    },

    isOpened: function () {
        return (!this._notification);
    },

    _onTimeout: function() {
        this._tries += 1;
        
        if (this.open()) {
            return false; // dialog finally opened
        }
        if (this._tries > FALLBACK_TIME * FALLBACK_RATE) {
            this.close(); // open notification as fallback
            return false;
        }
        return true; 
    },

    _onScreenSaverChanged: function(object, active) {
        if (!active)
            this.open();
    },

    _openNotification: function() {
        if (!this._notification) {
            let source = new NotificationSource();
            this._notification = new MessageTray.Notification(source,
                        this._notificationTitle, this._notificationDescription, {});
            this._notification.setResident(true);
            
            // Force to show description along with title,
            // as this is private property API may change
            try {
                this._notification._titleFitsInBannerMode = true;
            }
            catch(e) {
                global.logError('Pomodoro: ' + e.message);
            }
            
            // Create buttons
            for (let i=0; i < this._notificationButtons.length; i++) {
                try {
                    this._notification.addButton(i, this._notificationButtons[i].label);
                }
                catch (e) {
                    global.logError('Pomodoro: ' + e.message);
                }
            }
            
            // Connect actions
            this._notification.connect('action-invoked', Lang.bind(this, function(object, id) {
                    try {
                        this._notificationButtons[id].action();
                    }
                    catch (e) {
                        global.logError('Pomodoro: ' + e.message);
                    }
                }));
            this._notification.connect('clicked', Lang.bind(this, function() {
                    this.emit('clicked');
                }));
            
            Main.messageTray.add(source);
            source.notify(this._notification);
        }
        else
        {
            // Pop-up notification again
            let source = this._notification.source;
            source.notify(this._notification);
        }
    },

    _closeNotification: function() {
        if (this._notification) {
            this._notification.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
            this._notification = null;
        }
    },

    _enableEventCapture: function() {
        this._disableEventCapture();
        this._eventCaptureId = global.stage.connect('captured-event', Lang.bind(this, this._onEventCapture));
        this._eventCaptureSource = Mainloop.timeout_add(BLOCK_EVENTS_TIME, Lang.bind(this, this._onEventCaptureTimeout));
    },

    _disableEventCapture: function() {
        if (this._eventCaptureSource != 0) {
            GLib.source_remove(this._eventCaptureSource);
            this._eventCaptureSource = 0;
        }
        if (this._eventCaptureId != 0) {
            global.stage.disconnect(this._eventCaptureId);
            this._eventCaptureId = 0;
        }
    },

    _onEventCapture: function(actor, event) {
        switch(event.type()) {
            case Clutter.EventType.KEY_PRESS:
                let keysym = event.get_key_symbol();
                if (keysym == Clutter.Escape)
                    return false;
                // User might be looking at the keyboard while typing, so continue typing to the app.
                // TODO: pass typed letters to a focused object without blocking them
                this._enableEventCapture();
                return true;
            
            case Clutter.EventType.BUTTON_PRESS:
            case Clutter.EventType.BUTTON_RELEASE:
                return true;
        }
        return false;
    },

    _onEventCaptureTimeout: function() {
        this._disableEventCapture();
        return false;
    },

    _openWhenIdle: function() {
        this._disableIdleMonitor();
        this._idleMonitorWatchId = this._idleMonitor.add_watch(IDLE_TIME_TO_OPEN, Lang.bind(this, function(monitor, id, userBecameIdle) {
            if (userBecameIdle)
                this.open();
        }));
    },

    _closeWhenActive: function() {
        this._disableIdleMonitor();
        this._idleMonitorWatchId = this._idleMonitor.add_watch(IDLE_TIME_TO_CLOSE, Lang.bind(this, function(monitor, id, userBecameIdle) {
            if (!userBecameIdle) {
                this.close();
            }
        }));
    },
    
    _disableIdleMonitor: function() {
        if (this._idleMonitorWatchId != 0) {
            this._idleMonitor.remove_watch(this._idleMonitorWatchId);
            this._idleMonitorWatchId = 0;
        }
    },

    get timer() {
        return this._title;
    },

    setTimer: function(text) {
        this._timer = text;
        this._timerLabel.text = text;
    },

    get title() {
        return this._title;
    },

    setTitle: function(text) {
        this._title = text;
    },

    get description() {
        return this._description;
    },

    setDescription: function(text) {
        this._description = text;
        this._descriptionLabel.text = text;
    },

    get notificationTitle() {
        return this._notificationTitle;
    },

    setNotificationTitle: function(text) {
        this._notificationTitle = text;
        
        if (this._notification)
            this._notification.update(this._notificationTitle, this._notificationDescription);
    },

    setNotificationDescription: function(text) {
        this._notificationDescription = text;
        
        if (this._notification)
            this._notification.update(this._notificationTitle, this._notificationDescription);
    },

    setNotificationButtons: function(buttons) {
        this._notificationButtons = buttons;
    },

    _disconnectInternals: function() {
        this._disableEventCapture();
        this._disableIdleMonitor();
        
        if (this._timeoutSource != 0) {
            GLib.source_remove(this._timeoutSource);
            this._timeoutSource = 0;
        }
        if (this._screenSaverChangedId != 0) {
            this._screenSaver.disconnect(this._screenSaverChangedId);
            this._screenSaverChangedId = 0;
        }
    },

    destroy: function() {
        this._closeNotification();
        this._disconnectInternals();
        
        ModalDialog.ModalDialog.prototype.close.call(this);
        ModalDialog.ModalDialog.prototype.destroy.call(this);
    }
});
