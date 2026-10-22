"""Statistics handlers."""

from __future__ import annotations

from typing import TYPE_CHECKING

from aiogram import F, Router
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup

from backend.app.i18n import escape_md, get_language, t
from backend.app.services.telegram_handlers.common import NS, has_perm

if TYPE_CHECKING:
    from backend.app.models.telegram_chat import TelegramChat

router = Router()


async def render_stats(target, tg_chat: TelegramChat | None = None) -> None:
    """Render statistics. target can be Message or CallbackQuery."""
    lang = await get_language()

    if not has_perm(tg_chat, "stats:read"):
        if isinstance(target, CallbackQuery):
            await target.answer(t(lang, NS, "auth.no_permission"), show_alert=True)
        return

    from backend.app.core.database import async_session
    from backend.app.services.statistics import outcomes

    # The web overview's own classes and rate, over all counted prints (post-rebuild
    # D-R7): physical failures only in «failed», stopped/cancelled/skipped and
    # dispatch errors each on their own line, and neither in the success rate.
    async with async_session() as db:
        counts = await outcomes.outcome_counts(db)

    text = (
        f"\U0001f4ca *{escape_md(t(lang, NS, 'stats.title'))}*\n\n"
        f"{escape_md(t(lang, NS, 'stats.total'))}: {counts.total}\n"
        f"✅ {escape_md(t(lang, NS, 'stats.success'))}: {counts.completed}\n"
        f"❌ {escape_md(t(lang, NS, 'stats.failed'))}: {counts.physical_failures}\n"
        f"⏹ {escape_md(t(lang, NS, 'stats.stopped'))}: {counts.stopped}\n"
        f"⚠️ {escape_md(t(lang, NS, 'stats.dispatch_errors'))}: {counts.dispatch_failures}\n"
        f"\U0001f4c8 {escape_md(t(lang, NS, 'stats.success_rate'))}: {round(counts.success_rate)}%"
    )

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=f"\u25c0\ufe0f {t(lang, NS, 'printers.btn_main_menu')}", callback_data="menu:main"
                )
            ],
        ]
    )

    if isinstance(target, CallbackQuery):
        await target.message.edit_text(text, reply_markup=keyboard)
    else:
        await target.answer(text, reply_markup=keyboard)


@router.callback_query(F.data == "menu:stats")
async def cb_stats(callback: CallbackQuery, tg_chat: TelegramChat | None = None) -> None:
    await callback.answer()
    await render_stats(callback, tg_chat)
