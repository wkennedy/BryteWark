package com.anonymous.bulwarkmobile

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.facebook.react.views.modal.ReactModalHostView
import java.lang.ref.WeakReference

/**
 * "Hide in recent apps", second half. setRecentsScreenshotEnabled(false)
 * stops the snapshot Android keeps of the app, but opening recents straight
 * from the app shows the app's live window in its card: the app stays
 * resumed behind the launcher and only loses window focus. So while the
 * setting is on, a plain cover goes over the app's windows when none of them
 * has focus, and comes off as soon as one has it again.
 *
 * The app's windows are the activity and the dialogs it shows that this
 * class can find: React Native modals (every sheet and drawer) and dialog
 * fragments (React Native alerts). Focus moving from the activity to one of
 * those is not leaving the app, so it is not covered. Any other window the
 * app opens (a plain AlertDialog, a WebView's JavaScript alert, a
 * PopupWindow) is not found, so focus moving to it counts as leaving the app
 * and the activity is covered behind it until focus comes back.
 *
 * Main thread only.
 */
object RecentsCover {
    private const val TAG = "RecentsCover"
    private const val COVER_TAG = "bulwark_recents_cover"
    // A dialog that loses focus is checked again after this long, so focus
    // moving to the next window of the app (a dismissed sheet handing back to
    // the activity) does not blank the screen for a frame.
    private const val SETTLE_MS = 80L

    private val handler = Handler(Looper.getMainLooper())

    /** A dialog whose focus is followed, and the listener on its window. */
    private class Watch(
        val dialog: Dialog,
        val decor: View,
        val listener: ViewTreeObserver.OnWindowFocusChangeListener,
    )

    // Only showing dialogs stay here: prune() drops the rest, so a dismissed
    // dialog (and through its listener, nothing else) is not kept.
    private val watched = mutableListOf<Watch>()

    // While covered, how often to look for a dialog shown in the meantime (a
    // delayed alert, a sheet opened by a timer). Nothing announces one: React
    // Native mounts its modal host without an Android layout pass. Found, it
    // is covered and followed too, so the activity under it comes back with
    // it instead of staying blank behind it.
    private const val POLL_MS = 300L

    // The covered activity, while it is covered.
    private var covered: WeakReference<Activity>? = null

    private val poll = object : Runnable {
        override fun run() {
            val activity = covered?.get() ?: return
            // Only while the activity is resumed (behind recents or the
            // shade); onResume looks once more when it comes back otherwise.
            if (!isResumed(activity)) return
            onDialogMaybeShown()
            if (covered != null) handler.postDelayed(this, POLL_MS)
        }
    }

    /** From MainActivity.onWindowFocusChanged. */
    fun onActivityFocusChanged(activity: Activity, hasFocus: Boolean) {
        if (hasFocus) {
            uncover(activity)
            return
        }
        if (!BulwarkWindowModule.isRecentsHidden(activity)) return
        prune()
        val dialogs = shownDialogs(activity)
        // The activity handed focus to its own sheet or alert. Follow that
        // window instead: recents opened from it is a focus loss there.
        if (dialogs.isNotEmpty()) {
            dialogs.forEach { watch(activity, it) }
            return
        }
        cover(activity, dialogs)
    }

    /** From MainActivity.onResume: a dialog may have been shown meanwhile. */
    fun onResume(activity: Activity) {
        if (covered?.get() !== activity) return
        onDialogMaybeShown()
        if (covered != null) {
            handler.removeCallbacks(poll)
            handler.postDelayed(poll, POLL_MS)
        }
    }

    /** From MainActivity.onDestroy: let go of everything tied to it. */
    fun forget(activity: Activity) {
        uncover(activity)
        watched.toList().forEach { unwatch(it) }
    }

    /** Takes every cover off, e.g. when the setting is turned off. */
    fun uncover(activity: Activity) {
        handler.removeCallbacksAndMessages(null)
        stopNoticingDialogs()
        removeCover(activity.window.decorView)
        watched.forEach { removeCover(it.decor) }
        prune()
    }

    private fun onDialogFocusChanged(activityRef: WeakReference<Activity>, dialog: Dialog, hasFocus: Boolean) {
        val activity = activityRef.get() ?: return
        if (hasFocus) {
            uncover(activity)
            return
        }
        handler.postDelayed({
            val a = activityRef.get() ?: return@postDelayed
            if (a.isFinishing || a.isDestroyed) return@postDelayed
            if (!BulwarkWindowModule.isRecentsHidden(a)) return@postDelayed
            if (a.hasWindowFocus()) return@postDelayed
            prune()
            val dialogs = shownDialogs(a)
            if (dialogs.any { it.window?.decorView?.hasWindowFocus() == true }) return@postDelayed
            // A sheet opened from this one and not focused yet: follow it.
            val others = dialogs.filter { it !== dialog && !isWatched(it) }
            if (others.isNotEmpty()) {
                others.forEach { watch(a, it) }
                return@postDelayed
            }
            cover(a, dialogs)
        }, SETTLE_MS)
    }

    private fun isWatched(dialog: Dialog) = watched.any { it.dialog === dialog }

    private fun watch(activity: Activity, dialog: Dialog) {
        if (isWatched(dialog)) return
        val decor = dialog.window?.decorView ?: return
        val activityRef = WeakReference(activity)
        val dialogRef = WeakReference(dialog)
        val listener = ViewTreeObserver.OnWindowFocusChangeListener { hasFocus ->
            dialogRef.get()?.let { onDialogFocusChanged(activityRef, it, hasFocus) }
        }
        decor.viewTreeObserver.addOnWindowFocusChangeListener(listener)
        watched.add(Watch(dialog, decor, listener))
        if (BuildConfig.DEBUG) Log.d(TAG, "watching ${watched.size} dialog(s)")
    }

    private fun unwatch(w: Watch) {
        val observer = w.decor.viewTreeObserver
        if (observer.isAlive) observer.removeOnWindowFocusChangeListener(w.listener)
        watched.remove(w)
    }

    /** Drops the dialogs that are no longer showing. */
    private fun prune() {
        val gone = watched.filter { !it.dialog.isShowing }
        gone.forEach { unwatch(it) }
        if (BuildConfig.DEBUG && gone.isNotEmpty()) {
            Log.d(TAG, "dropped ${gone.size} dismissed dialog(s), watching ${watched.size}")
        }
    }

    // The dialogs on screen: React Native modals (hosted by a view in the
    // activity's tree) and dialog fragments.
    private fun shownDialogs(activity: Activity): List<Dialog> {
        val found = mutableListOf<Dialog>()
        fun visit(view: View) {
            if (view is ReactModalHostView) view.dialog?.takeIf { it.isShowing }?.let { found.add(it) }
            if (view is ViewGroup) for (i in 0 until view.childCount) visit(view.getChildAt(i))
        }
        visit(activity.window.decorView)
        if (activity is FragmentActivity) {
            activity.supportFragmentManager.fragments
                .filterIsInstance<DialogFragment>()
                .mapNotNull { it.dialog?.takeIf { d -> d.isShowing } }
                .forEach { found.add(it) }
        }
        return found
    }

    private fun coverColor(activity: Activity): Int =
        if (BulwarkWindowModule.isLightBackground(activity)) Color.WHITE else Color.parseColor("#09090b")

    private fun cover(activity: Activity, dialogs: List<Dialog>) {
        val color = coverColor(activity)
        addCover(activity.window.decorView, color)
        dialogs.forEach { addCover(it.window?.decorView, color) }
        startNoticingDialogs(activity)
    }

    // A dialog shown while covered: follow it, and cover it too unless it
    // already has focus, in which case the app is back.
    private fun onDialogMaybeShown() {
        val activity = covered?.get() ?: return
        prune()
        val fresh = shownDialogs(activity).filter { !isWatched(it) }
        if (fresh.isEmpty()) return
        if (BuildConfig.DEBUG) Log.d(TAG, "dialog shown while covered: ${fresh.size}")
        fresh.forEach { watch(activity, it) }
        if (fresh.any { it.window?.decorView?.hasWindowFocus() == true }) {
            uncover(activity)
            return
        }
        val color = coverColor(activity)
        fresh.forEach { addCover(it.window?.decorView, color) }
    }

    private fun startNoticingDialogs(activity: Activity) {
        if (covered != null) return
        covered = WeakReference(activity)
        handler.postDelayed(poll, POLL_MS)
    }

    private fun stopNoticingDialogs() {
        covered = null
        handler.removeCallbacks(poll)
    }

    private fun isResumed(activity: Activity): Boolean =
        (activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) ?: true

    private fun addCover(decor: View?, color: Int) {
        val group = decor as? ViewGroup ?: return
        if (group.findViewWithTag<View>(COVER_TAG) != null) return
        val cover = View(group.context).apply {
            tag = COVER_TAG
            setBackgroundColor(color)
            isClickable = true
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        group.addView(
            cover,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
    }

    private fun removeCover(decor: View?) {
        val group = decor as? ViewGroup ?: return
        group.findViewWithTag<View>(COVER_TAG)?.let { group.removeView(it) }
    }
}
