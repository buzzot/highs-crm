// Russian texts for the emails we send to clients. Same idea as the portal dictionary: English text exactly as the
// email prints it → Russian. Names, numbers and dates inside a sentence are kept by the patterns.
export const RU_EMAIL = {
  // layout
  'Button not working? Copy this link into your browser:': 'Кнопка не работает? Скопируйте ссылку в браузер:',
  'Lumi Trade · Sourcing, orders and shipments in one place': 'Lumi Trade · Подбор, заказы и отгрузки в одном месте',
  'Questions? Just reply to this email.': 'Вопросы? Просто ответьте на это письмо.',
  // invitation
  "You're invited to the Lumi Trade portal": 'Вас пригласили в кабинет Lumi Trade', 'Invitation': 'Приглашение', 'You’re invited to Lumi Trade': 'Вас пригласили в Lumi Trade',
  'On the next page, enter this confirmation code:': 'На следующей странице введите код подтверждения:', 'Accept invitation': 'Принять приглашение',
  "Didn't expect this? You can ignore this email.": 'Не ожидали письмо? Просто проигнорируйте его.',
  // codes
  'Invitation code': 'Код приглашения', 'Sign-in code': 'Код для входа', 'Here’s your code': 'Ваш код', 'Your one-time code:': 'Ваш одноразовый код:',
  'Enter this code on your invitation page to confirm your email address.': 'Введите этот код на странице приглашения, чтобы подтвердить email.',
  'Enter this code on the Lumi Trade sign-in page to finish signing in.': 'Введите этот код на странице входа Lumi Trade.',
  'Open invitation': 'Открыть приглашение', 'Open Lumi Trade': 'Открыть Lumi Trade', 'My account': 'Мой аккаунт',
  // reset
  'Reset your Lumi Trade password': 'Сброс пароля Lumi Trade', 'Choose a new password for your Lumi Trade account.': 'Задайте новый пароль для аккаунта Lumi Trade.',
  'Password reset': 'Сброс пароля', 'Choose a new password': 'Задайте новый пароль', 'Reset password': 'Сбросить пароль',
  // quote
  'New offer': 'Новое предложение', 'Your offer is ready': 'Ваше предложение готово', 'View the offer': 'Открыть предложение', 'Note from us:': 'Наш комментарий:',
  'The quotation is attached. Open it in your portal to review the price and accept it.': 'Предложение во вложении. Откройте его в кабинете, чтобы проверить цену и принять.',
  'Open it in your portal to review the price and accept it.': 'Откройте предложение в кабинете, чтобы проверить цену и принять.',
  // PO / PI
  'Purchase order': 'Заказ', 'We could not accept the purchase order yet': 'Пока не можем принять заказ', 'as sent.': 'в таком виде.', 'See the note from our team.': 'Смотрите комментарий нашей команды.',
  'Open the request': 'Открыть запрос', 'Proforma invoice': 'Инвойс (PI)', 'Open your order': 'Открыть заказ', 'Payment schedule:': 'График платежей:',
  'Thank you for your purchase order. Please find the proforma invoice': 'Спасибо за ваш заказ. Инвойс (PI)', 'After paying, open your order, upload the proof of payment and enter the amount.': 'После оплаты откройте заказ, загрузите подтверждение и укажите сумму.',
  'Shipping documents': 'Документы на груз', 'Please find attached:': 'Во вложении:',
  // changes
  'Changes approved': 'Правки одобрены', 'Changes not accepted': 'Правки не приняты', 'Updated offer on the way': 'Готовим новое предложение', 'The request stays as it was.': 'Запрос остаётся прежним.',
  // payments
  'Payment': 'Оплата', 'Payment received': 'Платёж получен', 'We could not confirm the payment': 'Не удалось подтвердить платёж', 'We received your payment.': 'Мы получили ваш платёж.',
  'Please check the note from our team.': 'Прочитайте комментарий нашей команды.', 'Please check the transfer and upload the proof again.': 'Проверьте перевод и загрузите подтверждение снова.',
  'for order': 'по заказу', '. Thank you!': '. Спасибо!', 'We confirmed your payment of': 'Мы подтвердили ваш платёж', 'We could not confirm your payment of': 'Не удалось подтвердить ваш платёж',
  'Your changes to': 'Ваши правки в запросе', 'We could not accept your changes to': 'Не удалось принять ваши правки в запросе',
  'are now part of the request. We are preparing an updated offer.': 'внесены в запрос. Готовим обновлённое предложение.', '. The request stays as it was.': '. Запрос остаётся прежним.',
  'We could not accept': 'Не удалось принять', 'We prepared an offer for': 'Мы подготовили предложение по',
  'We are preparing an updated offer.': 'Готовим новое предложение.',
};

export const RU_EMAIL_PATTERNS = [
  // subjects & preheaders
  [/^Your Lumi Trade invitation code: (\d+)$/, 'Код приглашения Lumi Trade: $1'], [/^Your Lumi Trade sign-in code: (\d+)$/, 'Код для входа в Lumi Trade: $1'],
  [/^Your invitation code is (\d+)\.$/, 'Ваш код приглашения: $1.'], [/^Your code is (\d+)$/, 'Ваш код: $1'],
  [/^Your offer for (.+) is ready$/, 'Ваше предложение по $1 готово'], [/^We prepared an offer for (\S+)\.$/, 'Мы подготовили предложение по $1.'],
  [/^Your purchase order (.+) needs changes$/, 'Заказ $1 требует правок'], [/^Proforma invoice (\S+) · order (\S+)$/, 'Инвойс (PI) $1 · заказ $2'], [/^Proforma invoice (\S+) for order (\S+)$/, 'Инвойс (PI) $1 по заказу $2'],
  [/^Order (\S+) is confirmed$/, 'Заказ $1 подтверждён'], [/^Order (\S+)$/, 'Заказ $1'], [/^Documents for order (\S+) · (.+)$/, 'Документы по заказу $1 · $2'],
  [/^(\d+) documents? attached for order (\S+)$/, 'Документов во вложении: $1 · заказ $2'],
  [/^Your changes to (\S+) were approved$/, 'Ваши правки в $1 одобрены'], [/^Your changes to (\S+) were not accepted$/, 'Ваши правки в $1 не приняты'],
  [/^Payment (.+) received · order (\S+)$/, 'Платёж $1 получен · заказ $2'], [/^Payment (.+) could not be confirmed · order (\S+)$/, 'Платёж $1 не подтверждён · заказ $2'],
  // invitation text
  [/^invited you to the Lumi Trade portal as a client of (.+?)\. Send sourcing requests, approve quotes and follow every order and shipment in one place\.$/, 'приглашает вас в кабинет Lumi Trade как клиента компании $1. Отправляйте запросы на подбор товаров, одобряйте предложения и следите за каждым заказом и отгрузкой — всё в одном месте.'],
  [/^You have been invited to the Lumi Trade portal as a client of (.+?)\. Send sourcing requests, approve quotes and follow every order and shipment in one place\.$/, 'Вас пригласили в кабинет Lumi Trade как клиента компании $1. Отправляйте запросы на подбор товаров, одобряйте предложения и следите за каждым заказом и отгрузкой — всё в одном месте.'],
  [/^The invitation link and code work for$/, 'Ссылка и код действуют'], [/^\. Didn't expect this\? You can ignore this email\.$/, '. Не ожидали письмо? Просто проигнорируйте его.'],
  [/^The code works once and expires in$/, 'Код действует один раз и истекает через'], [/^The code works once\.$/, 'Код действует один раз.'], [/^\. If you didn't try to sign in, someone may know your password — change it under$/, '. Если вы не пытались войти, возможно, кто-то знает ваш пароль — смените его в разделе'],
  [/^We received a request to reset the password for$/, 'Мы получили запрос на сброс пароля для'], [/^\. Click the button to choose a new one\.$/, '. Нажмите кнопку, чтобы задать новый.'],
  [/^The link works for$/, 'Ссылка действует'], [/^and only once\. If you didn't ask for this, you can ignore this email — your password stays the same\.$/, 'и только один раз. Если вы не запрашивали сброс, просто проигнорируйте письмо — пароль не изменится.'],
  // quote
  [/^\(valid until (.+?) · lead time (\d+) days\)\.$/, '(действует до $1 · срок $2 дн.).'], [/^\(valid until (.+?)\)\.$/, '(действует до $1).'], [/^\(lead time (\d+) days\)\.$/, '(срок $1 дн.).'],
  [/^\. It covers (\d+) products, total (.+)\.$/, '. Всего товаров: $1, итого $2.'], [/^It covers (\d+) products, total (.+)\.$/, 'Всего товаров: $1, итого $2.'], [/^(.+?) \(goods (.+?) \+ estimated freight & logistics (.+?)\)$/, '$1 (товары $2 + оценка доставки и логистики $3)'],
  [/^Questions\? Just reply to this email\.$/, 'Вопросы? Просто ответьте на это письмо.'],
  // PI
  [/^attached \((.+)\)\.$/, 'во вложении ($1).'], [/^Deposit \((\d+)%\):$/, 'Предоплата ($1%):'], [/^Balance \((\d+)%\):$/, 'Остаток ($1%):'], [/^· due (.+)$/, '· срок $1'], [/^(.+) · reply to this email with any questions\.$/, '$1 · по любым вопросам просто ответьте на это письмо.'],
  // payments
  [/^We confirmed your payment of (.+?) for order (\S+)\. Thank you!$/, 'Мы подтвердили ваш платёж $1 по заказу $2. Спасибо!'],
  [/^of$/, 'на сумму'],
];
