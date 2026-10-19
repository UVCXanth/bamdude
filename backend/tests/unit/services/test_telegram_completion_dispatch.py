"""Exercise the bot's actual Dispatcher wiring before completion filters run."""

import time
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from aiogram import Bot
from aiogram.types import Chat, Message, Update, User
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.group import Group
from backend.app.models.notification import NotificationProvider
from backend.app.models.telegram_chat import TelegramChat
from backend.app.services import telegram_bot as tb
from backend.app.services.telegram_handlers import defects

pytestmark = pytest.mark.unit


def _message(user_id=7, prompt_id=99, text="16"):
    reply = Message(
        message_id=prompt_id,
        date=datetime.now(timezone.utc),
        chat=Chat(id=4242, type="private"),
        from_user=User(id=123456, is_bot=True, first_name="Bot"),
        text="Count",
    )
    return Message(
        message_id=101,
        date=datetime.now(timezone.utc),
        chat=Chat(id=4242, type="private"),
        from_user=User(id=user_id, is_bot=False, first_name="Operator"),
        reply_to_message=reply,
        text=text,
    )


def _seed(provider_id):
    draft = defects._Draft(
        token="offline",
        archive_id=1,
        printer_id=5,
        owner=(provider_id, 4242, 7),
        rows=[],
        values={},
        flat=0,
        quantity=16,
        cursor=0,
        revision=1,
        expires_at=time.monotonic() + 300,
        source_message_ids={90},
        snapshot=(),
    )
    defects._drafts[draft.token] = draft
    defects._reply_prompts[(draft.owner, 99)] = (draft.token, draft.revision)
    return draft


@pytest.mark.asyncio
async def test_production_dispatcher_routes_only_owners_reply(db_session, test_engine):
    provider = NotificationProvider(
        name="Offline bot", provider_type="telegram", enabled=True, config='{"bot_token":"123456:OFFLINE_TEST"}'
    )
    group = Group(name="Operators", permissions=["printers:clear_plate"])
    db_session.add_all([provider, group])
    await db_session.flush()
    db_session.add(TelegramChat(chat_id=4242, provider_id=provider.id, group_id=group.id, is_active=True))
    await db_session.commit()
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    defects.clear_completion_drafts()
    tb._bots.clear()
    tb._bot_ids.clear()
    tb._dispatcher = None
    tb._polling_task = None
    finish = AsyncMock()
    try:
        with (
            patch("backend.app.core.database.async_session", maker),
            patch.object(tb, "current_bot_providers", AsyncMock(return_value=[(provider.id, "123456:OFFLINE_TEST")])),
            patch.object(
                Bot,
                "get_me",
                AsyncMock(return_value=User(id=123456, is_bot=True, first_name="Offline", username="offline")),
            ),
            patch.object(tb, "_register_commands", AsyncMock()),
            patch.object(tb, "_run_polling", AsyncMock()),
            patch.object(Message, "answer", AsyncMock()),
            patch.object(defects, "_finish", finish),
        ):
            await tb.start_telegram_bot()
            assert tb._dispatcher is not None
            bot = tb._bots[provider.id]
            draft = _seed(provider.id)
            await tb._dispatcher.feed_update(bot, Update(update_id=1, message=_message(user_id=8)))
            assert finish.await_count == 0 and draft.flat == 0
            await tb._dispatcher.feed_update(bot, Update(update_id=2, message=_message()))
            assert finish.await_count == 1 and draft.flat == 16
    finally:
        await tb._discard_bot_locked(tb._dispatcher, dict(tb._bots))
        defects.clear_completion_drafts()
