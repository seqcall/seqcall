package dev.seqcall.rider

import com.intellij.openapi.editor.colors.EditorColors
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.Color
import javax.swing.UIManager

/** The current IDE look as the `--vscode-*` variables of packages/webview/src/styles.css. */
object IdeTheme {
    fun current(): HtmlShell.Theme {
        val scheme = EditorColorsManager.getInstance().globalScheme
        val vars = linkedMapOf<String, String>()
        fun put(name: String, color: Color?) {
            if (color != null) vars[name] = HtmlShell.css(color.red, color.green, color.blue, color.alpha)
        }
        put("editor-background", scheme.defaultBackground)
        put("editor-foreground", scheme.defaultForeground)
        put("foreground", UIUtil.getLabelForeground())
        put("descriptionForeground", UIUtil.getContextHelpForeground())
        put("editorWidget-border", JBColor.border())
        put("editorWidget-background", UIUtil.getPanelBackground())
        put("textLink-foreground", JBUI.CurrentTheme.Link.Foreground.ENABLED)
        put("focusBorder", JBUI.CurrentTheme.Focus.focusColor())
        put("editor-selectionHighlightBackground", scheme.getColor(EditorColors.SELECTION_BACKGROUND_COLOR))
        put("menu-background", UIManager.getColor("PopupMenu.background"))
        put("menu-foreground", UIManager.getColor("PopupMenu.foreground"))
        put("menu-selectionBackground", UIManager.getColor("MenuItem.selectionBackground"))
        put("menu-selectionForeground", UIManager.getColor("MenuItem.selectionForeground"))
        put("toolbar-hoverBackground", JBUI.CurrentTheme.ActionButton.hoverBackground())
        put("list-hoverBackground", JBUI.CurrentTheme.List.Hover.background(true))
        vars["font-family"] = "'${UIUtil.getLabelFont().family}', system-ui, sans-serif"
        vars["editor-font-family"] = "'${scheme.editorFontName}', monospace"
        return HtmlShell.Theme(dark = !JBColor.isBright(), vars = vars)
    }
}
