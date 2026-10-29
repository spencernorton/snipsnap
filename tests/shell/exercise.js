import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

let instance;
export async function exercise(extension, {wait, expect}) {
    instance = extension;
    const trace = GLib.build_filenamev([GLib.get_user_cache_dir(), 'capture-daemon.log']);
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDERR_MERGE});
    launcher.set_stdout_file_path(trace);
    for (const [key, value] of Object.entries({XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME',
        QT_QPA_PLATFORM: 'wayland', WAYLAND_DISPLAY: GLib.getenv('WAYLAND_DISPLAY') || 'wayland-0',
        LIBGL_ALWAYS_SOFTWARE: '1', SNIPSNAP_CAPTURE_TRACE: 'stderr'}))
        launcher.setenv(key, value, true);
    const daemon = launcher.spawnv(['snipsnap']);
    const monitors = [...Main.layoutManager.monitors].sort((a, b) => a.x - b.x);
    expect(monitors.length === 2 && monitors[1].x > 0, 'Two adjacent real virtual monitors are required');
    const startX = monitors[1].x - 96;
    const endX = monitors[1].x + 96;
    const fixture = new St.Widget({x: startX - 16, y: 100, width: 256, height: 192,
        style: 'background-color: #336699;'});
    Main.uiGroup.add_child(fixture);
    const until = async (check, label) => {
        for (let i = 0; i < 200; i++) {
            const result = check();
            if (result)
                return result;
            await wait(50);
        }
        throw new Error(`Timed out waiting for ${label}`);
    };
    const seat = global.stage.get_context().get_backend().get_default_seat();
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const key = async symbol => {
        keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.PRESSED);
        await wait(40);
        keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.RELEASED);
        await wait(75);
    };
    try {
        await until(() => Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', ['tech.norvi.snipsnap']),
            new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, 500, null).deepUnpack()[0],
        'the actual packaged daemon');
        for (const symbol of [Clutter.KEY_Super_L, Clutter.KEY_Shift_L, Clutter.KEY_s]) {
            keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.PRESSED);
            await wait(40);
        }
        for (const symbol of [Clutter.KEY_s, Clutter.KEY_Shift_L, Clutter.KEY_Super_L]) {
            keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.RELEASED);
            await wait(40);
        }
        await until(() => extension._root?.visible, 'the real compositor capture overlay');
        expect(extension._captureContent?.get_texture(), 'The compositor supplied no screenshot texture');
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 600, 400);
        await wait(100);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), startX, 120);
        await until(() => global.get_pointer()[0] === startX && global.get_pointer()[1] === 120, 'the initialized native pointer');
        await wait(100);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await wait(100);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), endX, 248);
        await wait(100);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await wait(100);
        expect(extension._selection?.width === 193 && extension._selection?.height === 129,
            `Native pointer selection is wrong: ${JSON.stringify(extension._selection)}`);
        await key(Clutter.KEY_Return);
        const editor = await until(() => global.get_window_actors().map(actor => actor.meta_window)
            .find(window => window?.get_title()?.startsWith('SnipSnap [capture-id=')),
        'the real Qt editor after PNG encode and daemon handoff');
        await until(() => !extension._root, 'the committed capture to close its overlay');
        expect(editor.get_compositor_private()?.mapped, 'The packaged editor window is not mapped');
        await until(() => {
            const [ok, bytes] = GLib.file_get_contents(trace);
            if (!ok)
                return false;
            const events = new TextDecoder().decode(bytes).split('\n')
                .filter(line => line.startsWith('SNIPSNAP_CAPTURE_TRACE '))
                .map(line => JSON.parse(line.slice('SNIPSNAP_CAPTURE_TRACE '.length)));
            return events.some(event => event.event === 'shell_bridge_region_received' &&
                event.fields.pixel_width === 193 && event.fields.pixel_height === 129) &&
                events.some(event => event.event === 'editor_ready');
        }, 'the daemon to decode the selected pixels and finish its editor');
        console.log(`RUNTIME-ACCEPTANCE capture: 193x129, editor=${editor.get_title()}`);
    } finally {
        fixture.destroy();
        daemon.send_signal(15);
        let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            timer = 0;
            daemon.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        await new Promise(resolve => daemon.wait_async(null, (source, result) => {
            source.wait_finish(result);
            if (timer)
                GLib.source_remove(timer);
            resolve();
        }));
        const [ok, bytes] = GLib.file_get_contents(trace);
        if (ok)
            console.log(`RUNTIME-ACCEPTANCE daemon log:\n${new TextDecoder().decode(bytes)}`);
    }
}

export async function disabled({expect}) {
    expect(!instance._root && !instance._enabled, 'Disabling retained the capture overlay or active bridge');
}
