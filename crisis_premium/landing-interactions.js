// Smooth scroll for anchors
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function (e) {
                if (this.getAttribute('href') === '#') {
                    return;
                }
                e.preventDefault();
                document.querySelector(this.getAttribute('href')).scrollIntoView({
                    behavior: 'smooth'
                });
            });
        });

        function getMoscowDateParts() {}

        try { localStorage.removeItem('aspbWebinarTargetMsk'); } catch(e) {}

        const emotionCards = document.querySelectorAll('.emotion-card');
        const problemEmotionPanel = document.getElementById('problemEmotionPanel');
        const problemEmotionTitle = document.getElementById('problemEmotionTitle');
        const problemEmotionText = document.getElementById('problemEmotionText');

        emotionCards.forEach(card => {
            card.addEventListener('click', () => {
                emotionCards.forEach(item => item.setAttribute('aria-pressed', 'false'));

                card.setAttribute('aria-pressed', 'true');
                card.classList.remove('emotion-pop');
                void card.offsetWidth;
                card.classList.add('emotion-pop');

                problemEmotionTitle.textContent = card.dataset.emotionTitle;
                problemEmotionText.textContent = card.dataset.emotionText;
                problemEmotionPanel.classList.remove('emotion-panel-pop');
                void problemEmotionPanel.offsetWidth;
                problemEmotionPanel.classList.add('emotion-panel-pop');
            });
        });

        const incomeCards = document.querySelectorAll('.income-card');
        const incomeDetail = document.getElementById('incomeDetail');
        const incomeDetailTitle = document.getElementById('incomeDetailTitle');
        const incomeDetailAmount = document.getElementById('incomeDetailAmount');
        const incomeDetailEmotion = document.getElementById('incomeDetailEmotion');
        const incomeDetailText = document.getElementById('incomeDetailText');
        const incomeStepOne = document.getElementById('incomeStepOne');
        const incomeStepTwo = document.getElementById('incomeStepTwo');
        const incomeStepThree = document.getElementById('incomeStepThree');
        const incomeLossMonthly = document.getElementById('incomeLossMonthly');
        const incomeLossYearly = document.getElementById('incomeLossYearly');
        const incomeLossPhrase = document.getElementById('incomeLossPhrase');
        const incomeLossFill = document.getElementById('incomeLossFill');
        const incomeNumberFormatter = new Intl.NumberFormat('ru-RU');
        const incomeCounters = new WeakMap();
        function formatIncome(value) {
            return `от ${incomeNumberFormatter.format(Math.round(value))} ₽`;
        }
        function animateIncomeCounter(node, target) {
            if (!node) return;
            const previous = incomeCounters.get(node) || target * 0.72;
            const startedAt = performance.now();
            const duration = 620;
            incomeCounters.set(node, target);
            function frame(now) {
                const progress = Math.min(1, (now - startedAt) / duration);
                const eased = 1 - Math.pow(1 - progress, 3);
                const current = previous + (target - previous) * eased;
                node.textContent = formatIncome(current);
                if (progress < 1) {
                    requestAnimationFrame(frame);
                }
            }
            requestAnimationFrame(frame);
        }
        function updateIncomeLossMeter(card) {
            const monthlyValue = Number(card.dataset.incomeMonthlyValue || 0);
            const yearlyValue = Number(card.dataset.incomeYearlyValue || monthlyValue * 12);
            animateIncomeCounter(incomeLossMonthly, monthlyValue);
            animateIncomeCounter(incomeLossYearly, yearlyValue);
            incomeLossPhrase.textContent = card.dataset.incomeEmotion;
            incomeLossFill.style.width = `${card.dataset.incomeLossWidth || 55}%`;
        }

        const defaultIncomeCard = document.querySelector('.income-card[aria-selected="true"]');
        if (defaultIncomeCard) {
            updateIncomeLossMeter(defaultIncomeCard);
        }

        incomeCards.forEach(card => {
            card.addEventListener('click', () => {
                incomeCards.forEach(item => {
                    item.setAttribute('aria-selected', 'false');
                });

                card.setAttribute('aria-selected', 'true');

                incomeDetailTitle.textContent = card.dataset.incomeTitle;
                incomeDetailAmount.textContent = card.dataset.incomeAmount;
                incomeDetailEmotion.textContent = card.dataset.incomeEmotion;
                incomeDetailText.textContent = card.dataset.incomeDetail;
                incomeStepOne.textContent = card.dataset.incomeStepOne;
                incomeStepTwo.textContent = card.dataset.incomeStepTwo;
                incomeStepThree.textContent = card.dataset.incomeStepThree;
                updateIncomeLossMeter(card);

                card.classList.remove('income-pop');
                void card.offsetWidth;
                card.classList.add('income-pop');

                incomeDetail.classList.remove('income-detail-pop');
                void incomeDetail.offsetWidth;
                incomeDetail.classList.add('income-detail-pop');
            });
        });

        const chainChoices = document.querySelectorAll('.chain-choice');
        const chainPanel = document.getElementById('chainPanel');
        const chainIcon = document.getElementById('chainIcon');
        const chainTitle = document.getElementById('chainTitle');
        const chainText = document.getElementById('chainText');

        chainChoices.forEach(choice => {
            choice.addEventListener('click', () => {
                chainChoices.forEach(item => item.setAttribute('aria-pressed', 'false'));

                choice.setAttribute('aria-pressed', 'true');
                chainIcon.textContent = choice.dataset.chainIcon;
                chainTitle.textContent = choice.dataset.chainTitle;
                chainText.textContent = choice.dataset.chainText;

                choice.classList.remove('chain-pop');
                void choice.offsetWidth;
                choice.classList.add('chain-pop');

                chainPanel.classList.remove('chain-panel-pop');
                void chainPanel.offsetWidth;
                chainPanel.classList.add('chain-panel-pop');
            });
        });

        const programCards = document.querySelectorAll('.program-card');
        const programOutcome = document.getElementById('programOutcome');
        const programOutcomeIcon = document.getElementById('programOutcomeIcon');
        const programOutcomeTitle = document.getElementById('programOutcomeTitle');
        const programOutcomeText = document.getElementById('programOutcomeText');
        const programOutcomeResult = document.getElementById('programOutcomeResult');

        programCards.forEach(card => {
            card.addEventListener('click', () => {
                programCards.forEach(item => item.setAttribute('aria-pressed', 'false'));

                card.setAttribute('aria-pressed', 'true');
                programOutcomeIcon.textContent = card.dataset.programIcon;
                programOutcomeTitle.textContent = card.dataset.programTitle;
                programOutcomeText.textContent = card.dataset.programText;
                programOutcomeResult.textContent = card.dataset.programResult;

                card.classList.remove('program-pop');
                void card.offsetWidth;
                card.classList.add('program-pop');

                programOutcome.classList.remove('program-panel-pop');
                void programOutcome.offsetWidth;
                programOutcome.classList.add('program-panel-pop');
            });
        });

        const faqCards = document.querySelectorAll('.faq-card');
        faqCards.forEach(card => {
            card.addEventListener('toggle', () => {
                if (!card.open) {
                    return;
                }

                faqCards.forEach(item => {
                    if (item !== card) {
                        item.removeAttribute('open');
                    }
                });

                card.classList.remove('faq-pop');
                void card.offsetWidth;
                card.classList.add('faq-pop');
            });
        });

        (function() {
          const scaleTabs = document.querySelectorAll('#regScaleTab1, #regScaleTab2');
          const scaleText = document.getElementById('regScaleText');
          const scaleContents = {
            regScaleTab1: 'Банкротство — не "поражение", а инструмент защиты бизнеса и активов, если к нему подходят заранее и профессионально.',
            regScaleTab2: 'За вашей рекомендацией стоит команда АУ и 17 000+ успешных дел. Это сильнее, чем вести сложный кейс в одиночку.'
          };
          scaleTabs.forEach(tab => {
            tab.addEventListener('click', () => {
              scaleTabs.forEach(t => t.setAttribute('aria-selected', 'false'));
              tab.setAttribute('aria-selected', 'true');
              scaleText.textContent = scaleContents[tab.id] || '';
            });
          });
        })();

        function initSiteClickRipple() {
            if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                return;
            }

            document.addEventListener('pointerdown', event => {
                if (event.button !== 0 || event.pointerType === 'touch' && event.isPrimary === false) {
                    return;
                }

                const ripple = document.createElement('span');
                ripple.className = 'site-click-ripple';
                ripple.style.left = `${event.clientX}px`;
                ripple.style.top = `${event.clientY}px`;
                document.body.appendChild(ripple);
                ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
            });
        }

        initSiteClickRipple();
