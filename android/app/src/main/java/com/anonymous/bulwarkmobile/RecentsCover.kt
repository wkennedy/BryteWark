package com.anonymous.bulwarkmobile

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.FragmentActivity
import com.facebook.react.views.modal.ReactModalHostView
import java.util.WeakHashMap

/**
 * "Hide in recent apps", second half. setRecentsScreenshotEnabled(false)
 * stops the snapshot Android keeps of the app, but opening recents straight
 * from the app shows the app's live window in its card: the app stays
 * resumed behind the launcher and only loses window focus. So while the
 * setting is on, a plain cover goes over the app's windows when none of them
 * has focus, and comes off as soon as one has it again.
 *
 * The app's windows are the activity and the dialogs it shows (React Native
 * modals, which every sheet and drawer is, and alerts). Focus moving from the
 * activity to one of those is not leaving the app, so it is not covered.
 */
object RecentsCover {
    private const val COVER_TAG = "bulwark_recents_cover"
    // A dialog that loses focus is checked again after this long, so focus
    // moving to the next window of the app (a dismissed sheet handing back to
    // the activity) does not blank the screen for a frame.
    private const val SETTLE_MS = 80L

    private val handler = Handler(Looper.getMainLooper())
    private val watched = WeakHashMap<Dialog, ViewTreeObserver.OnWindowFocusChangeListener>()

    /** From MainActivity.onWindowFocusChanged. */
    fun onActivityFocusChanged(activity: Activity, hasFocus: Boolean) {
        if (hasFocus) {
            uncover(activity)
            return
        }
        if (!BulwarkWindowModule.isRecentsHidden(activity)) return
        val dialogs = shownDialogs(activity)
        // The activity handed focus to its own sheet or alert. Watch that
        // window instead: recents opened from it is a focus loss there.
        if (dialogs.isNotEmpty()) {
            dialogs.forEach { watch(activity, it) }
            return
        }
        cover(activity, dialogs)
    }

    /** Takes every cover off, e.g. when the setting is turned off. */
    fun uncover(activity: Activity) {
        handler.removeCallbacksAndMessages(null)
        removeCover(activity.window.decorView)
        watched.keys.toList().forEach { removeCover(it.window?.decorView) }
    }

    private fun onDialogFocusChanged(activity: Activity, dialog: Dialog, hasFocus: Boolean) {
        if (hasFocus) {
            uncover(activity)
            return
        }
        handler.postDelayed({
            if (activity.isFinishing || activity.isDestroyed) return@postDelayed
            if (!BulwarkWindowModule.isRecentsHidden(activity)) return@postDelayed
            if (activity.hasWindowFocus()) return@postDelayed
            val dialogs = shownDialogs(activity)
            if (dialogs.any { it.window?.decorView?.hasWindowFocus() == true }) return@postDelayed
            // A sheet opened from this one and not focused yet: watch it.
            val others = dialogs.filter { it !== dialog && !watched.containsKey(it) }
            if (others.isNotEmpty()) {
                others.forEach { watch(activity, it) }
                return@postDelayed
            }
            cover(activity, dialogs)
        }, SETTLE_MS)
    }

    private fun watch(activity: Activity, dialog: Dialog) {
        if (watched.containsKey(dialog)) return
        val decor = dialog.window?.decorView ?: return
        val listener = ViewTreeObserver.OnWindowFocusChangeListener { hasFocus ->
            onDialogFocusChanged(activity, dialog, hasFocus)
        }
        decor.viewTreeObserver.addOnWindowFocusChangeListener(listener)
        watched[dialog] = listener
    }

    // The dialogs on screen: React Native modals (hosted by a view in the
    // activity's tree) and alert fragments.
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

    private fun cover(activity: Activity, dialogs: List<Dialog>) {
        val color = if (BulwarkWindowModule.isLightBackground(activity)) Color.WHITE else Color.parseColor("#09090b")
        addCover(activity.window.decorView, color)
        dialogs.forEach { addCover(it.window?.decorView, color) }
    }

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
