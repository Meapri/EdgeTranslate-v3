/** @jsx h */
import { h, Fragment } from "preact";
import { useEffect, useState, useRef, useCallback } from "preact/hooks";
import { useLatest, useEvent, useClickAway } from "react-use";
import styled, { createGlobalStyle } from "styled-components";
import root from "react-shadow/styled-components";
import SimpleBar from "simplebar-react";
import SimpleBarStyle from "simplebar-react/dist/simplebar.min.css";
import Channel from "common/scripts/channel.js";
import { checkTimestamp } from "./utils.js";
import Moveable from "./library/moveable/moveable.js";
import { delayPromise } from "common/scripts/promise.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";
import Result from "./Result.jsx"; // display translate result
import Loading from "./Loading.jsx"; // display loading animation
import Error from "./Error.jsx"; // display error messages
import Dropdown from "./Dropdown.jsx";
import SettingIcon from "./icons/setting.svg";
import PinIcon from "./icons/pin.svg";
import CloseIcon from "./icons/close.svg";

// Communication channel.
const channel = new Channel();
// Store the translation result and attach it to window.
window.translateResult = {};
// Flag of showing result.
window.isDisplayingResult = false;
// Store the width of scroll bar.
const scrollbarWidth = getScrollbarWidth();
// Store original css text on document.body.
let documentBodyCSS = "";
// The duration time of result panel's transition. unit: ms.
const transitionDuration = 360;
const transitionEasing = "cubic-bezier(0.2, 0, 0, 1)";
const DarkPrimary = "#a8c7fa";
const DarkOnSurface = "#e8eaed";
const DarkOnSurfaceVariant = "#bdc1c6";
const DarkSurface = "#1b2026";
const DarkSurfaceContainer = "#20262d";
const DarkOutline = "#3d4651";
const MotionFast = "120ms cubic-bezier(0.2, 0, 0, 1)";
const MotionStandard = "180ms cubic-bezier(0.2, 0, 0, 1)";

import { pickBestVoice } from "./voiceSelection.js";

export default function ResultPanel() {
    // Whether the result is open.
    const [open, setOpen] = useState(false);
    // Whether the panel is fixed(the panel won't be close when users click outside of the it).
    const [panelFix, setPanelFix] = useState();
    // "LOADING" | "RESULT" | "ERROR"
    const [contentType, setContentType] = useState("LOADING");
    const contentTypeRef = useLatest(contentType);
    // translate results or error messages
    const [content, setContent] = useState({});
    // refer to the latest content equivalent to useRef()
    const contentRef = useLatest(content);
    // available translators for current language setting
    const [availableTranslators, setAvailableTranslators] = useState();
    // selected translator
    const [currentTranslator, setCurrentTranslator] = useState();
    // Control the behavior of highlight part(a placeholder to preview the "fixed" style panel).
    const [highlight, setHighlight] = useState({
        show: false, // whether to show the highlight part
        position: "right", // the position of the highlight part. value: "left"|"right"
    });
    // state of display type("floating" | "fixed")
    const [displayType, setDisplayType] = useState("floating");

    const containerElRef = useRef(), // the container of translation panel.
        panelElRef = useRef(), // panel element
        headElRef = useRef(), // panel head element
        bodyElRef = useRef(); // panel body element

    // Indicate whether the movable panel is ready or not.
    const [moveableReady, setMoveableReady] = useState(false);
    // store the moveable object returned by moveable.js
    const moveablePanelRef = useRef(null);
    const simplebarRef = useRef();

    // 기억된 부동 패널 위치(사용자가 드래그로 이동한 경우)
    const lastFloatingPosRef = useRef(null); // { x: number, y: number }
    const userMovedRef = useRef(false);
    // 마지막 앵커(선택된 단어) 기준 좌표 기억 (캐시 히트 시 position 누락 대비)
    const lastAnchorPosRef = useRef(null); // [x, y]

    // store the display type("floating"|"fixed")
    const displaySettingRef = useRef({
        type: "floating",
        fixedData: {
            width: 0.2,
            position: "right",
        },
        floatingData: {
            width: 0.15, // V2 원본과 동일한 비율 값 (15%)
            height: 0.6, // V2 원본과 동일한 비율 값 (60%)
        },
    });

    /**
     * Content Script에서 TTS를 실행하는 함수
     */
    const executeTTS = useCallback(async (detail) => {
        const { pronouncing, text, language, speed, timestamp } = detail;

        try {
            // 우선 Web Speech API 사용 시도
            if (typeof speechSynthesis !== "undefined") {
                return new Promise((resolve, reject) => {
                    // 진행 중인 음성 합성 중단
                    speechSynthesis.cancel();

                    const utter = new SpeechSynthesisUtterance(text);
                    // 언어 정규화 및 최적 음성 선택
                    (async () => {
                        try {
                            const { lang: normLang, voice } = await pickBestVoice(language);
                            if (normLang) utter.lang = normLang;
                            if (voice) utter.voice = voice;
                            // 한국어는 너무 빠르게 들리는 경향 보정
                            // 언어/브라우저별 속도 튜닝 제거: 일관된 기본 속도 사용
                            utter.rate = speed === "fast" ? 1.0 : 0.8;
                            // 약간의 톤 보정
                            utter.pitch = 1.0;
                        } catch {}
                        speechSynthesis.speak(utter);
                    })();

                    let isFinished = false; // 중복 처리 방지

                    const finishTTS = () => {
                        if (isFinished) return;
                        isFinished = true;

                        // 백그라운드를 통해 Result.jsx로 전달
                        channel
                            .request("tts_finished", {
                                pronouncing,
                                text,
                                language,
                                timestamp,
                            })
                            .catch(() => {
                                // 요청 실패시 직접 이벤트 전송 (fallback)
                                channel.emit("pronouncing_finished", {
                                    pronouncing,
                                    text,
                                    language,
                                    timestamp,
                                });
                            });
                        resolve();
                    };

                    utter.onstart = () => {
                        // TTS 재생 시작
                    };

                    utter.onend = () => {
                        finishTTS("onend");
                    };

                    utter.onerror = (error) => {
                        const errorType = error.error || "unknown";

                        // 실제 합성 실패인 경우에만 에러로 처리
                        if (errorType === "synthesis-failed" || errorType === "network") {
                            if (!isFinished) {
                                isFinished = true;
                                console.warn("[EdgeTranslate] 실제 TTS 오류:", errorType);
                                channel
                                    .request("tts_error", {
                                        pronouncing,
                                        error: { message: `TTS 오류: ${errorType}` },
                                        timestamp,
                                    })
                                    .catch(() => {
                                        // fallback
                                        channel.emit("pronouncing_error", {
                                            pronouncing,
                                            error: { message: `TTS 오류: ${errorType}` },
                                            timestamp,
                                        });
                                    });
                                reject(error);
                            }
                            return;
                        }

                        // 다른 모든 경우는 완료로 처리 (보통 정상 완료 상황)
                        finishTTS("completed");
                    };
                });
            }

            throw new Error("speechSynthesis API가 지원되지 않습니다");
        } catch (error) {
            // speechSynthesis API가 지원되지 않는 경우만 실제 오류로 처리
            if (
                error.message &&
                error.message.includes("speechSynthesis API가 지원되지 않습니다")
            ) {
                throw error;
            } else {
                // SpeechSynthesisErrorEvent 등 일반적인 TTS 이벤트는 조용히 처리하되 완료 이벤트 전송
                channel
                    .request("tts_finished", {
                        pronouncing,
                        text,
                        language,
                        timestamp,
                    })
                    .catch(() => {
                        // fallback
                        channel.emit("pronouncing_finished", {
                            pronouncing,
                            text,
                            language,
                            timestamp,
                        });
                    });
            }
        }
    }, []);

    const stopTTS = useCallback(() => {
        try {
            if (typeof speechSynthesis !== "undefined") {
                speechSynthesis.cancel();

                // TTS 중지 완료 이벤트 발송
                channel.emit("pronouncing_finished", {
                    pronouncing: "both", // source와 target 모두 중지
                    timestamp: new Date().getTime(),
                });
            }
        } catch (error) {
            // TTS 중지 실패는 무시
        }
    }, []);

    // flag whether the user set to resize document body when panel is resized in fixed display mode
    const resizePageFlag = useRef(false);

    /**
     * V2 원본과 동일한 bounds 업데이트 함수 복원
     */
    const updateBounds = useCallback(async () => {
        // If the panel is open
        if (containerElRef.current) {
            await getDisplaySetting();
            let scrollLeft = document.documentElement.scrollLeft || document.body.scrollLeft;
            let scrollTop = document.documentElement.scrollTop || document.body.scrollTop;

            // V2 원본과 동일한 bounds 계산 - 자유로운 드래그를 위해 넓은 영역 허용
            moveablePanelRef.current?.setBounds({
                left: scrollLeft,
                top: scrollTop,
                right: scrollLeft + window.innerWidth - (hasScrollbar() ? scrollbarWidth : 0),
                bottom:
                    scrollTop +
                    (1 + displaySettingRef.current.floatingData.height) * window.innerHeight -
                    64,
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * The handler for window resize event.
     * Update drag bounds and the size or position of the result panel.
     */
    const windowResizeHandler = useCallback(() => {
        updateBounds();
        // If result panel is open.
        if (panelElRef.current) {
            if (displaySettingRef.current.type === "fixed") showFixedPanel();
            else showFloatingPanel();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* Do some initialization stuff */
    useEffect(() => {
        getDisplaySetting();

        getOrSetDefaultSettings(["languageSetting", "DefaultTranslator"], DEFAULT_SETTINGS).then(
            async (result) => {
                let languageSetting = result.languageSetting;
                let availableTranslators = await channel.request("get_available_translators", {
                    from: languageSetting.sl,
                    to: languageSetting.tl,
                });
                setAvailableTranslators(availableTranslators);
                setCurrentTranslator(result.DefaultTranslator);
            }
        );

        getOrSetDefaultSettings("fixSetting", DEFAULT_SETTINGS).then((result) => {
            setPanelFix(result.fixSetting);
        });

        /*
         * COMMUNICATE WITH BACKGROUND MODULE
         */
        // The translator send this request to make sure current tab can display result panel.
        channel.provide("check_availability", () => Promise.resolve());

        channel.on("start_translating", (detail) => {
            if (checkTimestamp(detail.timestamp)) {
                // cache translation text.
                window.translateResult.originalText = detail.text;
                if (detail.position && Array.isArray(detail.position)) {
                    lastAnchorPosRef.current = [detail.position[0], detail.position[1]];
                }
                setOpen(true);
                setContentType("LOADING");
                setContent(detail);
            }
        });

        channel.on("translating_finished", (detail) => {
            if (checkTimestamp(detail.timestamp)) {
                window.translateResult = detail;
                if (detail.position && Array.isArray(detail.position)) {
                    lastAnchorPosRef.current = [detail.position[0], detail.position[1]];
                }
                setOpen(true);
                setContentType("RESULT");
                setContent(detail);
            }
        });

        channel.on("translating_stream", (detail) => {
            if (checkTimestamp(detail.timestamp)) {
                window.translateResult = detail;
                if (detail.position && Array.isArray(detail.position)) {
                    lastAnchorPosRef.current = [detail.position[0], detail.position[1]];
                }
                setOpen(true);
                setContentType("RESULT");
                setContent((previous) => ({
                    ...(previous || {}),
                    ...detail,
                    isStreaming: true,
                }));
            }
        });

        channel.on("translating_error", (detail) => {
            if (checkTimestamp(detail.timestamp)) {
                if (detail.position && Array.isArray(detail.position)) {
                    lastAnchorPosRef.current = [detail.position[0], detail.position[1]];
                }
                setContentType("ERROR");
                setContent(detail);
            }
        });

        channel.on("update_translator_options", (detail) => {
            setAvailableTranslators(detail.availableTranslators);
            setCurrentTranslator(detail.selectedTranslator);
        });

        channel.on("command", (detail) => {
            switch (detail.command) {
                case "fix_result_frame":
                    getOrSetDefaultSettings("fixSetting", DEFAULT_SETTINGS).then((result) => {
                        setPanelFix(!result.fixSetting);
                        chrome.storage.sync.set({
                            fixSetting: !result.fixSetting,
                        });
                    });
                    break;
                case "close_result_frame":
                    setOpen(false);
                    break;
                default:
                    break;
            }
        });

        // TTS 실행 메시지 처리
        channel.on("execute_tts", async (detail) => {
            if (checkTimestamp(detail.timestamp)) {
                try {
                    // Content Script에서 TTS 실행
                    await executeTTS(detail);
                } catch (error) {
                    // 실제 오류만 에러 메시지 전송 (SpeechSynthesisErrorEvent 등은 제외)
                    if (
                        error &&
                        error.message &&
                        error.message.includes("speechSynthesis API가 지원되지 않습니다")
                    ) {
                        console.warn("[EdgeTranslate] TTS 지원되지 않음:", error.message);
                        channel.emit("pronouncing_error", {
                            pronouncing: detail.pronouncing,
                            error: { message: "TTS가 지원되지 않습니다" },
                            timestamp: detail.timestamp,
                        });
                    }
                    // 기타 일반적인 TTS 이벤트는 조용히 무시
                }
            }
        });

        // TTS 중지 메시지 처리
        channel.on("stop_tts", () => {
            stopTTS();
        });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * When status of result panel is changed(open or close), this function will be triggered.
     */
    const onDisplayStatusChange = useCallback((panelEl) => {
        panelElRef.current = panelEl;

        /* If panel is closed */
        if (!panelEl) {
            // Clear the outdated moveable object.
            moveablePanelRef.current = null;
            setMoveableReady(false);

            // 패널을 닫을 때 임시 위치 기억은 유지(다음 열기에 사용),
            // 필요시 완전 초기화를 원하면 아래 주석을 해제하세요.
            // lastFloatingPosRef.current = null;
            // userMovedRef.current = false;

            // Tell select.js that the result panel has been removed.
            window.isDisplayingResult = false;

            removeFixedPanel();

            // Tell background module that the result panel has been closed
            channel.emit("frame_closed");
            return;
        }

        /* else if panel is open */
        // Tell select.js that we are displaying results.
        window.isDisplayingResult = true;

        /* Make the resultPanel resizable and draggable */
        moveablePanelRef.current = new Moveable(panelEl, {
            draggable: true,
            resizable: true,
            /* Set threshold value to increase the resize area */
            threshold: 5,
            /**
             * Set thresholdPosition to decide where the resizable area is
             */
            thresholdPosition: 0.7,
            minWidth: 180,
            minHeight: 150,
            // V2처럼 자유로운 드래그를 위해 bounds를 나중에 동적으로 설정
        });

        let startTranslate = [0, 0];
        // To flag whether the floating panel should be changed to fixed panel.
        let floatingToFixed = false;
        // Store the fixed direction on bound event.
        let fixedDirection = "";

        /* V2 원본과 동일한 draggable events 복원 */
        moveablePanelRef.current
            .on("dragStart", ({ set, stop, inputEvent }) => {
                if (inputEvent) {
                    const path =
                        inputEvent.path || (inputEvent.composedPath && inputEvent.composedPath());
                    // If drag element isn't the head element, stop the drag event.
                    if (!path || !headElRef.current?.isSameNode(path[0])) {
                        stop();
                        return;
                    }
                }
                set(startTranslate);
            })
            .on("drag", ({ target, translate }) => {
                startTranslate = translate;
                target.style.transform = `translate(${translate[0]}px, ${translate[1]}px)`;
            })
            .on("dragEnd", ({ translate, inputEvent }) => {
                startTranslate = translate;

                /* Change the display type of result panel */
                if (inputEvent && displaySettingRef.current.type === "floating") {
                    // 사용자가 이동한 위치를 기억
                    if (Array.isArray(translate) && translate.length === 2) {
                        lastFloatingPosRef.current = { x: translate[0], y: translate[1] };
                        userMovedRef.current = true;
                    }
                    if (floatingToFixed) {
                        displaySettingRef.current.fixedData.position = fixedDirection;
                        displaySettingRef.current.type = "fixed";
                        // 고정 모드로 전환 시 부동 위치는 사용하지 않음
                        // lastFloatingPosRef.current = null;
                        // userMovedRef.current = false;
                        // remove the highlight part
                        setHighlight({
                            show: false,
                            position: "right",
                        });
                        showFixedPanel();
                        updateDisplaySetting();
                    }
                }
            })
            // The result panel drag out of the drag area
            .on("bound", ({ direction, distance }) => {
                /* Whether to show hight part on the one side of the page*/
                if (displaySettingRef.current.type === "floating") {
                    let threshold = 10;
                    if (distance > threshold) {
                        if (direction === "left" || direction === "right") {
                            fixedDirection = direction;
                            floatingToFixed = true;
                            // show highlight part
                            setHighlight({
                                show: true,
                                position: direction,
                            });
                        }
                    }
                }
            })
            // The result panel drag into drag area first time
            .on("boundEnd", () => {
                if (floatingToFixed)
                    // remove the highlight part
                    setHighlight({
                        show: false,
                        position: "right",
                    });
                floatingToFixed = false;
                // Change the display type from fixed to floating
                if (displaySettingRef.current.type === "fixed") {
                    displaySettingRef.current.type = "floating";
                    removeFixedPanel();
                    showFloatingPanel();
                    updateDisplaySetting();
                    // The height of content in fixed panel may be different from the height in floating panel so we need to update the height of floating panel after a little delay.
                    setTimeout(showFloatingPanel, 50);
                }
            });
        /* Listen to resizable  events */
        moveablePanelRef.current
            .on("resizeStart", ({ set }) => {
                set(startTranslate);
            })
            .on("resize", ({ target, width, height, translate, inputEvent }) => {
                target.style.width = `${width}px`;
                target.style.height = `${height}px`;
                target.style.transform = `translate(${translate[0]}px, ${translate[1]}px)`;
                if (inputEvent) {
                    if (displaySettingRef.current.type === "fixed" && resizePageFlag.current) {
                        document.body.style.width = `${(1 - width / window.innerWidth) * 100}%`;
                    }
                    // 부동 모드에서 리사이즈 시 현재 위치도 기억
                    if (
                        displaySettingRef.current.type === "floating" &&
                        Array.isArray(translate) &&
                        translate.length === 2
                    ) {
                        lastFloatingPosRef.current = { x: translate[0], y: translate[1] };
                        userMovedRef.current = true;
                    }
                }
            })
            .on("resizeEnd", ({ translate, width, height, inputEvent, target }) => {
                startTranslate = translate;
                target.style.transform = `translate(${translate[0]}px, ${translate[1]}px)`;

                // Update new size of the result panel
                if (inputEvent) {
                    if (displaySettingRef.current.type === "floating") {
                        displaySettingRef.current.floatingData.width = width / window.innerWidth;
                        displaySettingRef.current.floatingData.height = height / window.innerHeight;
                    } else {
                        displaySettingRef.current.fixedData.width = width / window.innerWidth;
                    }
                    updateDisplaySetting();
                }
            });
        showPanel();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* 콘텐츠 타입 변경 후: 높이 조정 + (필요 시) 앵커 기준 재배치 */
    useEffect(() => {
        if (displaySettingRef.current.type === "floating") {
            setTimeout(showFloatingPanel, contentType === "LOADING" ? 0 : 100);
            // 사용자가 직접 옮기지 않았고, 앵커가 있다면 재배치
            if (!userMovedRef.current && moveablePanelRef.current) {
                const width = displaySettingRef.current.floatingData.width * window.innerWidth;
                const height = displaySettingRef.current.floatingData.height * window.innerHeight;
                let base = null;
                if (contentRef.current.position && Array.isArray(contentRef.current.position)) {
                    base = [contentRef.current.position[0], contentRef.current.position[1]];
                } else if (lastAnchorPosRef.current) {
                    base = [lastAnchorPosRef.current[0], lastAnchorPosRef.current[1]];
                }
                if (base) {
                    const XBias = 20,
                        YBias = 20,
                        threshold = height / 4;
                    let position = [base[0], base[1]];
                    if (position[0] + width > window.innerWidth)
                        position[0] = position[0] - width - XBias;
                    if (position[1] + height > window.innerHeight + threshold) {
                        let newPosition1 = position[1] - height - YBias + threshold;
                        position[1] = newPosition1 < 0 ? 0 : newPosition1;
                    }
                    position = [position[0] + XBias, position[1] + YBias];
                    moveablePanelRef.current.request("draggable", {
                        x: position[0],
                        y: position[1],
                    });
                }
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contentType]);

    // Update drag bounds when users scroll the page
    useEvent("scroll", updateBounds, window);

    // Update the drag bounds and size when the size of window has changed
    useEvent("resize", windowResizeHandler, window);

    useClickAway(containerElRef, () => {
        // The panel will be closed if users click outside of the it with the panelFix option closed.
        if (!panelFix) {
            setOpen(false);
        }
    });

    /**
     * V2 원본과 동일한 패널 표시 함수 복원
     */
    async function showPanel() {
        await getDisplaySetting();
        updateBounds(); // V2처럼 bounds를 동적으로 설정

        if (displaySettingRef.current.type === "floating") {
            /* show floating panel */
            let position;
            let width = displaySettingRef.current.floatingData.width * window.innerWidth;
            let height = displaySettingRef.current.floatingData.height * window.innerHeight;

            // 위치 우선순위: 현재 position -> 마지막 앵커 -> 마지막 부동 -> 기본
            if (contentRef.current.position) {
                /* Adjust the position of result panel. Avoid to beyond the range of page */
                const XBias = 20,
                    YBias = 20,
                    threshold = height / 4;
                position = [contentRef.current.position[0], contentRef.current.position[1]];

                // The result panel would exceeds the right boundary of the page.
                if (position[0] + width > window.innerWidth) {
                    position[0] = position[0] - width - XBias;
                }
                // The result panel would exceeds the bottom boundary of the page.
                if (position[1] + height > window.innerHeight + threshold) {
                    // Make true the panel wouldn't exceed the top boundary.
                    let newPosition1 = position[1] - height - YBias + threshold;
                    position[1] = newPosition1 < 0 ? 0 : newPosition1;
                }
                position = [position[0] + XBias, position[1] + YBias];
            } else if (lastAnchorPosRef.current) {
                const XBias = 20,
                    YBias = 20,
                    threshold = height / 4;
                position = [lastAnchorPosRef.current[0], lastAnchorPosRef.current[1]];
                if (position[0] + width > window.innerWidth) {
                    position[0] = position[0] - width - XBias;
                }
                if (position[1] + height > window.innerHeight + threshold) {
                    let newPosition1 = position[1] - height - YBias + threshold;
                    position[1] = newPosition1 < 0 ? 0 : newPosition1;
                }
                position = [position[0] + XBias, position[1] + YBias];
            } else if (userMovedRef.current && lastFloatingPosRef.current) {
                position = [lastFloatingPosRef.current.x, lastFloatingPosRef.current.y];
            } else {
                position = [
                    (1 - displaySettingRef.current.floatingData.width) * window.innerWidth -
                        (hasScrollbar() ? scrollbarWidth : 0),
                    0,
                ];
            }

            showFloatingPanel();
            // V2처럼 즉시 위치 설정 (setTimeout 없이)
            moveablePanelRef.current.request("draggable", { x: position[0], y: position[1] });
        } else {
            showFixedPanel();
        }
        // Indicate that the movable panel is ready to show.
        setMoveableReady(true);
    }

    /**
     * Show the result panel in the floating type.
     */
    function showFloatingPanel() {
        if (!moveablePanelRef.current) return;
        setDisplayType("floating");

        let panelWidth = displaySettingRef.current.floatingData.width * window.innerWidth;
        let panelHeight = displaySettingRef.current.floatingData.height * window.innerHeight;

        /* Fit the panel to the content size */
        if (contentTypeRef.current === "RESULT" || contentTypeRef.current === "ERROR") {
            // Guard against unmounted refs or transient nulls from SimpleBar
            const headH = headElRef.current?.clientHeight || 0;
            const contentEl =
                typeof simplebarRef.current?.getContentElement === "function"
                    ? simplebarRef.current.getContentElement()
                    : null;
            const contentH = contentEl?.clientHeight || 0;
            const actualHeight = headH + contentH;
            // If the height of simplebar content element isn't 0.
            if (actualHeight !== headH && panelHeight > actualHeight) panelHeight = actualHeight;
        }

        moveablePanelRef.current.request("resizable", {
            width: panelWidth,
            height: panelHeight,
        });
    }

    /**
     * Show the result panel in the fixed type.
     */
    function showFixedPanel() {
        setDisplayType("fixed");
        let width = displaySettingRef.current.fixedData.width * window.innerWidth;
        // the offset left value for fixed result panel
        let offsetLeft = 0;
        if (displaySettingRef.current.fixedData.position === "right")
            offsetLeft = window.innerWidth - width - (hasScrollbar() ? scrollbarWidth : 0);
        getOrSetDefaultSettings("LayoutSettings", DEFAULT_SETTINGS).then(async (result) => {
            resizePageFlag.current = result.LayoutSettings.Resize;
            // user set to resize the document body
            if (resizePageFlag.current) {
                // If `documentBodyCSS` is empty, this means the panel is created for the first time. Ths creation animation is only needed when the panel is firstly created.
                if (documentBodyCSS === "") {
                    // store the original css text. when fixed panel is removed, restore the style of document.body
                    documentBodyCSS = document.body.style.cssText;

                    document.body.style.position = "absolute";
                    document.body.style.transition = `width ${transitionDuration}ms ${transitionEasing}`;
                    panelElRef.current.style.transition = `width ${transitionDuration}ms ${transitionEasing}`;
                    /* set the start width to make the transition effect work */
                    document.body.style.width = "100%";
                    move(0, window.innerHeight, offsetLeft, 0);
                    // wait some time to make the setting of width applied
                    await delayPromise(50);
                }
                // the fixed panel in on the left side
                if (displaySettingRef.current.fixedData.position === "left") {
                    document.body.style.right = "0";
                    document.body.style.left = "";
                }
                // the fixed panel in on the right side
                else {
                    document.body.style.margin = "0";
                    document.body.style.right = "";
                    document.body.style.left = "0";
                }
                // set the target width for document body
                document.body.style.width = `${
                    (1 - displaySettingRef.current.fixedData.width) * 100
                }%`;
                // set the target width for the result panel
                move(width, window.innerHeight, offsetLeft, 0);
                /* cancel the transition effect after the panel showed */
                await delayPromise(transitionDuration);
                panelElRef.current.style.transition = "";
                document.body.style.transition = "";
            } else move(width, window.innerHeight, offsetLeft, 0);
        });
    }

    /**
     * If user choose to resize the document body, make the page return to normal size.
     */
    async function removeFixedPanel() {
        if (resizePageFlag.current) {
            document.body.style.transition = `width ${transitionDuration}ms ${transitionEasing}`;
            await delayPromise(50);
            document.body.style.width = "100%";
            await delayPromise(transitionDuration);
            document.body.style.cssText = documentBodyCSS;
            documentBodyCSS = "";
        }
    }

    /**
     * Drag the target element to a specified position and resize it to a specific size.
     * @param {number} width width
     * @param {number} height height value
     * @param {number} left x-axis coordinate of the target position
     * @param {number} top y-axis coordinate of the target position
     */
    function move(width, height, left, top) {
        moveablePanelRef.current.request("draggable", {
            x: left,
            y: top,
        });
        moveablePanelRef.current.request("resizable", {
            width,
            height,
        });
    }

    /**
     * Get the display setting in chrome.storage api.
     * @returns {Promise{undefined}} null promise
     */
    function getDisplaySetting() {
        return new Promise((resolve) => {
            getOrSetDefaultSettings("DisplaySetting", DEFAULT_SETTINGS).then((result) => {
                if (result.DisplaySetting) {
                    displaySettingRef.current = result.DisplaySetting;

                    // V2 -> V3 마이그레이션: 잘못된 값들을 보정
                    let needsUpdate = false;

                    // fixedData가 없거나 잘못된 구조인 경우에만 기본값으로 초기화
                    if (
                        !displaySettingRef.current.fixedData ||
                        typeof displaySettingRef.current.fixedData.width !== "number" ||
                        !displaySettingRef.current.fixedData.position
                    ) {
                        displaySettingRef.current.fixedData = {
                            width: 0.2,
                            position: "right",
                        };
                        needsUpdate = true;
                    }

                    // floatingData가 없거나 잘못된 구조인 경우 기본값으로 초기화
                    if (!displaySettingRef.current.floatingData) {
                        displaySettingRef.current.floatingData = {
                            width: 0.15,
                            height: 0.6,
                        };
                        needsUpdate = true;
                    } else {
                        // width/height가 1보다 크면 픽셀값이므로 비율로 변환
                        if (displaySettingRef.current.floatingData.width > 1) {
                            displaySettingRef.current.floatingData.width = 0.15;
                            needsUpdate = true;
                        }
                        if (displaySettingRef.current.floatingData.height > 1) {
                            displaySettingRef.current.floatingData.height = 0.6;
                            needsUpdate = true;
                        }
                        // position 값 제거 (V2에서는 자동 계산)
                        if (displaySettingRef.current.floatingData.position) {
                            delete displaySettingRef.current.floatingData.position;
                            needsUpdate = true;
                        }
                    }

                    // type이 없거나 잘못된 값인 경우에만 floating으로 설정
                    if (
                        !displaySettingRef.current.type ||
                        (displaySettingRef.current.type !== "floating" &&
                            displaySettingRef.current.type !== "fixed")
                    ) {
                        displaySettingRef.current.type = "floating";
                        needsUpdate = true;
                    }

                    // 보정된 값이 있으면 저장소에 업데이트
                    if (needsUpdate) {
                        updateDisplaySetting();
                    }
                } else {
                    updateDisplaySetting();
                }
                resolve();
            });
        });
    }

    /**
     * Update the display setting in chrome.storage.
     */
    function updateDisplaySetting() {
        chrome.storage.sync.set({ DisplaySetting: displaySettingRef.current });
    }

    return (
        <Fragment>
            {open && (
                <root.div ref={containerElRef} style={{}}>
                    <GlobalStyle />
                    <Panel
                        ref={onDisplayStatusChange}
                        displayType={displayType}
                        data-testid="Panel"
                    >
                        {
                            // Only show the panel's content when the panel is movable.
                            moveableReady && (
                                <Fragment>
                                    <Head ref={headElRef} data-testid="Head">
                                        <SourceOption
                                            role="button"
                                            title={chrome.i18n.getMessage(
                                                `${currentTranslator}Short`
                                            )}
                                            activeKey={currentTranslator}
                                            onSelect={(eventKey) => {
                                                setCurrentTranslator(eventKey);
                                                channel
                                                    .request("update_default_translator", {
                                                        translator: eventKey,
                                                    })
                                                    .then(() => {
                                                        if (window.translateResult.originalText)
                                                            channel.request("translate", {
                                                                text: window.translateResult
                                                                    .originalText,
                                                            });
                                                    });
                                            }}
                                            data-testid="SourceOption"
                                        >
                                            {availableTranslators?.map((translator) => (
                                                <Dropdown.Item
                                                    role="button"
                                                    key={translator}
                                                    eventKey={translator}
                                                >
                                                    {chrome.i18n.getMessage(translator)}
                                                </Dropdown.Item>
                                            ))}
                                        </SourceOption>
                                        <HeadIcons>
                                            <HeadIcon
                                                role="button"
                                                title={chrome.i18n.getMessage("Settings")}
                                                onClick={() => channel.emit("open_options_page")}
                                                data-testid="SettingIcon"
                                            >
                                                <SettingIcon />
                                            </HeadIcon>
                                            <HeadIcon
                                                role="button"
                                                title={chrome.i18n.getMessage(
                                                    panelFix ? "UnfixResultFrame" : "FixResultFrame"
                                                )}
                                                onClick={() => {
                                                    setPanelFix(!panelFix);
                                                    chrome.storage.sync.set({
                                                        fixSetting: !panelFix,
                                                    });
                                                }}
                                                data-testid="PinIcon"
                                            >
                                                <StyledPinIcon fix={panelFix} />
                                            </HeadIcon>
                                            <HeadIcon
                                                role="button"
                                                title={chrome.i18n.getMessage("CloseResultFrame")}
                                                onClick={() => setOpen(false)}
                                                data-testid="CloseIcon"
                                            >
                                                <CloseIcon />
                                            </HeadIcon>
                                        </HeadIcons>
                                    </Head>
                                    <Body ref={bodyElRef}>
                                        <SimpleBar ref={simplebarRef}>
                                            {contentType === "LOADING" && <Loading />}
                                            {contentType === "RESULT" && <Result {...content} />}
                                            {contentType === "ERROR" && <Error {...content} />}
                                        </SimpleBar>
                                    </Body>
                                </Fragment>
                            )
                        }
                    </Panel>
                </root.div>
            )}
            {highlight.show && (
                <Highlight
                    style={{
                        width: displaySettingRef.current.fixedData.width * window.innerWidth,
                        [highlight.position]: 0,
                    }}
                />
            )}
        </Fragment>
    );
}

/**
 * STYLE FOR THE COMPONENT START
 */

export const MaxZIndex = 2147483647;
const ColorPrimary = "#0b57d0";
const PanelBorderRadius = "8px";
export const ContentWrapperCenterClassName = "simplebar-content-wrapper-center";

const GlobalStyle = createGlobalStyle`
    ${SimpleBarStyle}

    /* Fix content disappearing problem. */
    [data-simplebar] {
        width: 100%;
        height: 100%;
        max-height: 100%;
    }

    /* Fix content horizontally overflowing problem. */
    .simplebar-offset {
        width: 100%;
    }

    /* Adjust width of the vertical scrollbar. */
    .simplebar-track.simplebar-vertical {
        width: 10px;
        top: 10px;
        right: 8px;
        bottom: 10px;
        border-radius: 999px;
        background: transparent;
    }

    /* Adjust height of the horizontal scrollbar. */
    .simplebar-track.simplebar-horizontal {
        height: 10px;
        left: 10px;
        right: 10px;
        bottom: 8px;
        border-radius: 999px;
        background: transparent;
    }

    /* Adjust position, shape and color of the scrollbar thumb. */
    .simplebar-scrollbar:before {
        left: 2px;
        right: 2px;
        border-radius: 999px;
        background-color: rgba(95, 99, 104, 0.42);
        transition: background-color ${MotionFast}, opacity ${MotionFast};
    }

    /* Apply to the content wrapper, which is the parent element of simplebar-content, to align content in the vertical center. */
    .${ContentWrapperCenterClassName} {
        display: flex;
        flex-direction: column;

        // "justify-content: center;" may cause part of content hidden when overflowing, so we use pseudo elements to simulate its effect.
        &::before,
        &::after {
            content: "";
            flex: 1;
        }
    }

    /* Adjust the content container, which is the parent element of Panel Body. */
    .simplebar-content {
        width: 100%;
        box-sizing: border-box;
        padding: 12px 22px 16px 14px !important;
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        align-items: stretch;
    }

    @media (prefers-color-scheme: dark) {
        .simplebar-scrollbar:before {
            background-color: rgba(189, 193, 198, 0.48);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
            animation-duration: 1ms !important;
            animation-iteration-count: 1 !important;
            scroll-behavior: auto !important;
            transition-duration: 1ms !important;
        }
    }
`;

/**
 * @param {{
 *   displayType: "floating" | "fixed";
 * }} props
 */
const Panel = styled.div`
    display: flex;
    flex-direction: column;
    flex-wrap: nowrap;
    justify-content: flex-start;
    align-items: stretch;
    position: fixed;
    top: 0;
    left: 0;
    z-index: ${MaxZIndex};
    border-radius: ${(props) => (props.displayType === "floating" ? PanelBorderRadius : 0)};
    overflow: visible;
    box-shadow: 0 12px 30px rgba(60, 64, 67, 0.16), 0 3px 8px rgba(60, 64, 67, 0.12);
    background: #ffffff;
    border: 1px solid rgba(225, 227, 225, 0.92);

    /* Normalize the style of panel */
    padding: 0;
    margin: 0;
    border: none;
    font-size: 16px;
    font-weight: normal;
    color: #202124;
    line-height: 1;
    -webkit-text-size-adjust: 100%;
    box-sizing: border-box;
    -moz-tab-size: 4;
    tab-size: 4;
    font-family: system-ui, -apple-system,
        /* Firefox supports this but not yet 'system-ui' */ "Segoe UI", Roboto, Helvetica, Arial,
        sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
    animation: et-panel-enter ${MotionStandard} both;
    transition: background-color ${MotionStandard}, box-shadow ${MotionStandard},
        color ${MotionStandard}, opacity ${MotionFast};

    @keyframes et-panel-enter {
        from {
            opacity: 0;
        }

        to {
            opacity: 1;
        }
    }

    &:before {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        z-index: -1;
        display: block;
        background: rgba(255, 255, 255, 0.82);
        backdrop-filter: blur(10px);
        height: 100%;
        border-radius: ${(props) => (props.displayType === "floating" ? PanelBorderRadius : 0)};
    }

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurface};
        background: ${DarkSurface};
        box-shadow: 0 16px 34px rgba(0, 0, 0, 0.42), 0 4px 12px rgba(0, 0, 0, 0.3);

        &:before {
            background: rgba(27, 32, 38, 0.86);
        }
    }
`;

const Head = styled.div`
    min-height: 56px;
    padding: 8px 10px 8px 12px;
    display: flex;
    justify-content: flex-start;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    min-width: 0;
    overflow: visible;
    cursor: grab;
    border-bottom: 1px solid #e1e3e1;
    background: linear-gradient(180deg, #ffffff, #f8fafd);
    border-radius: ${PanelBorderRadius} ${PanelBorderRadius} 0 0;
    transition: background ${MotionStandard}, border-color ${MotionStandard};

    @media (prefers-color-scheme: dark) {
        border-bottom-color: ${DarkOutline};
        background: linear-gradient(180deg, ${DarkSurfaceContainer}, ${DarkSurface});
    }
`;

const HeadIcons = styled.div`
    display: flex;
    flex-direction: row;
    justify-content: flex-end;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    margin-left: auto;
    min-width: 0;
`;

const HeadIcon = styled.div`
    display: flex;
    justify-content: center;
    align-items: center;
    font-style: normal;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    cursor: pointer;
    font-size: 18px;
    width: 36px;
    height: 36px;
    margin: 0 1px;
    background-color: transparent;
    border-radius: 999px;
    transition: background-color ${MotionFast}, color ${MotionFast};

    svg {
        fill: #5f6368;
        width: 20px;
        height: 20px;
        display: block;
        transition: fill ${MotionFast};
    }

    &:hover {
        background: rgba(11, 87, 208, 0.08);
    }

    &:hover svg {
        fill: ${ColorPrimary};
    }

    @media (prefers-color-scheme: dark) {
        svg {
            fill: ${DarkOnSurfaceVariant};
        }

        &:hover {
            background: rgba(168, 199, 250, 0.14);
        }

        &:hover svg {
            fill: ${DarkPrimary};
        }
    }
`;

const StyledPinIcon = styled(PinIcon)`
    transition: transform ${MotionStandard}, fill ${MotionFast} !important;
    ${(props) => (props.fix ? "" : "transform: rotate(45deg)")}
`;

const Body = styled.div`
    width: 100%;
    box-sizing: border-box;
    font-weight: normal;
    font-size: medium;
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    overflow-x: hidden;
    overflow-y: overlay;
    overscroll-behavior: contain;
    background: linear-gradient(180deg, rgba(241, 244, 248, 0.9), rgba(248, 250, 253, 0)), #f8fafd;
    flex-grow: 1;
    flex-shrink: 1;
    word-break: break-word;
    transition: background ${MotionStandard};

    @media (prefers-color-scheme: dark) {
        background: linear-gradient(180deg, rgba(36, 42, 49, 0.74), rgba(27, 32, 38, 0)), #15191d;
    }
`;

const SourceOption = styled(Dropdown)`
    flex: 0 1 auto;
    min-width: 0;
    max-width: min(55%, 180px);
    font-weight: normal;
    font-size: 13px;
    cursor: pointer;
    // To center the text in select box
    text-align-last: center;
    color: ${ColorPrimary};
    background-color: #d3e3fd;
    border-color: transparent;
    border-radius: 999px;
    min-height: 40px;
    padding: 0 12px;
    outline: none;
    transition: background-color ${MotionFast}, color ${MotionFast};

    @media (prefers-color-scheme: dark) {
        color: ${DarkPrimary};
        background-color: #1f3b68;
    }
`;

const Highlight = styled.div`
    height: 100%;
    background: ${ColorPrimary};
    opacity: 0.3;
    position: fixed;
    top: 0;
    z-index: ${MaxZIndex};
    pointer-events: none;
`;

/**
 * STYLE FOR THE COMPONENT END
 */

/**
 * Calculate the width of scroll bar.
 * method: create a div element with a scroll bar and calculate the difference between offsetWidth and clientWidth
 * @returns {number} the width of scroll bar
 */
function getScrollbarWidth() {
    let scrollDiv = document.createElement("div");
    scrollDiv.style.cssText =
        "width: 99px; height: 99px; overflow: scroll; position: absolute; top: -9999px;";
    document.documentElement.appendChild(scrollDiv);
    let scrollbarWidth = scrollDiv.offsetWidth - scrollDiv.clientWidth;
    document.documentElement.removeChild(scrollDiv);
    return scrollbarWidth;
}

/**
 * Judge whether the current page has a scroll bar.
 */
function hasScrollbar() {
    return (
        document.body.scrollHeight > (window.innerHeight || document.documentElement.clientHeight)
    );
}
