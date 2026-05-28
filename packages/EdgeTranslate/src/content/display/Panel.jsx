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
import { delayPromise } from "common/scripts/promise.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";
import Result from "./Result.jsx"; // display translate result
import Loading from "./Loading.jsx"; // display loading animation
import Error from "./Error.jsx"; // display error messages
import Dropdown from "./Dropdown.jsx";
import SettingIcon from "./icons/setting.svg";
import PinIcon from "./icons/pin.svg";
import CloseIcon from "./icons/close.svg";

function getI18nMessage(name, fallback = "") {
    const message = chrome.i18n.getMessage(name);
    return message || fallback;
}

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
const transitionEasing = "cubic-bezier(0.25, 1, 0.5, 1)";
const DarkPrimary = "#a8c7fa";
const DarkOnSurface = "#e8eaed";
const DarkOnSurfaceVariant = "#bdc1c6";
const DarkOutline = "#3d4651";
const MotionFast = "180ms cubic-bezier(0.25, 1, 0.5, 1)";
const MotionStandard = "280ms cubic-bezier(0.25, 1, 0.5, 1)";
const MotionFloatingSpotlightIn = "210ms cubic-bezier(0.2, 0, 0, 1)";
const MotionFloatingSpotlightOut = "170ms cubic-bezier(0.32, 0, 0.67, 0)";
const MotionSnappy = "360ms cubic-bezier(0.16, 1, 0.3, 1)";
const DetachResizeMotion = "240ms cubic-bezier(0.2, 1, 0.2, 1)";
const PanelRadius = "28px";
const FloatingMargin = 16;
const SlideOverMargin = 16;
const SlideOverWidthMin = 320;
const SlideOverWidthMax = 420;
const DockPreviewZone = 44;
const DockCommitZone = 26;
const FlickDockZone = 120;
const FlickVelocity = 0.95;
const FloatingWidthMin = 260;
const FloatingWidthMaxRatio = 0.42;
const FloatingHeightMin = 220;
const FloatingHeightMaxRatio = 0.78;

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

    // Indicate whether the native window controller is ready or not.
    const [moveableReady, setMoveableReady] = useState(false);
    const windowControllerRef = useRef(null);
    const frameRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
    const pendingFrameRef = useRef(null);
    const frameRafRef = useRef(0);
    const panelMotionTimerRef = useRef(0);
    const closeTimerRef = useRef(0);
    const simplebarRef = useRef();

    // 기억된 부동 패널 위치(사용자가 드래그로 이동한 경우)
    const lastFloatingPosRef = useRef(null); // { x: number, y: number }
    const userMovedRef = useRef(false);
    const dragStateRef = useRef({
        startType: "floating",
        startFixedPosition: "right",
        dockCandidate: null,
        samples: [],
    });
    // 마지막 앵커(선택된 단어) 기준 좌표 기억 (캐시 히트 시 position 누락 대비)
    const lastAnchorPosRef = useRef(null); // [x, y]
    const lastOpenedAtRef = useRef(0);

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
            position: null,
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

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function getViewportMetrics() {
        return {
            width: window.innerWidth - (hasScrollbar() ? scrollbarWidth : 0),
            height: window.innerHeight,
        };
    }

    function getFloatingSizeFromSetting() {
        const viewport = getViewportMetrics();
        const configuredWidth = displaySettingRef.current.floatingData.width * viewport.width;
        const configuredHeight = displaySettingRef.current.floatingData.height * viewport.height;
        return {
            width: clamp(
                configuredWidth,
                Math.min(FloatingWidthMin, viewport.width - FloatingMargin * 2),
                Math.max(FloatingWidthMin, viewport.width * FloatingWidthMaxRatio)
            ),
            height: clamp(
                configuredHeight,
                Math.min(FloatingHeightMin, viewport.height - FloatingMargin * 2),
                Math.max(FloatingHeightMin, viewport.height * FloatingHeightMaxRatio)
            ),
        };
    }

    function getFixedPanelWidth(viewport = getViewportMetrics()) {
        return clamp(
            displaySettingRef.current.fixedData.width * viewport.width,
            Math.min(SlideOverWidthMin, viewport.width - SlideOverMargin * 2),
            Math.min(SlideOverWidthMax, viewport.width * 0.42, viewport.width - SlideOverMargin * 2)
        );
    }

    function clampFloatingPosition(position, width, height) {
        const viewport = getViewportMetrics();
        return [
            clamp(
                position[0],
                FloatingMargin,
                Math.max(FloatingMargin, viewport.width - width - FloatingMargin)
            ),
            clamp(
                position[1],
                FloatingMargin,
                Math.max(FloatingMargin, viewport.height - height - FloatingMargin)
            ),
        ];
    }

    function getDockCandidate(translate, width) {
        const viewport = getViewportMetrics();
        if (translate[0] <= DockPreviewZone) return "left";
        if (translate[0] + width >= viewport.width - DockPreviewZone) return "right";
        return null;
    }

    function getDockCommitCandidate(translate, width) {
        const viewport = getViewportMetrics();
        if (translate[0] <= DockCommitZone) return "left";
        if (translate[0] + width >= viewport.width - DockCommitZone) return "right";
        return null;
    }

    function recordDragSample(inputEvent, translate) {
        if (!inputEvent) return;
        const samples = dragStateRef.current.samples || [];
        samples.push({
            x: inputEvent.clientX,
            y: inputEvent.clientY,
            panelX: translate[0],
            at: performance.now(),
        });
        if (samples.length > 5) samples.shift();
        dragStateRef.current.samples = samples;
    }

    function getDragVelocityX() {
        const samples = dragStateRef.current.samples || [];
        if (samples.length < 2) return 0;
        const first = samples[0];
        const last = samples[samples.length - 1];
        const elapsed = Math.max(1, last.at - first.at);
        return (last.x - first.x) / elapsed;
    }

    function getReleaseDockCandidate(translate, width) {
        const directCandidate = getDockCommitCandidate(translate, width);
        if (directCandidate) return directCandidate;

        const viewport = getViewportMetrics();
        const velocityX = getDragVelocityX();
        const nearLeft = translate[0] <= FlickDockZone;
        const nearRight = translate[0] + width >= viewport.width - FlickDockZone;
        if (nearLeft && velocityX <= -FlickVelocity) return "left";
        if (nearRight && velocityX >= FlickVelocity) return "right";
        return null;
    }

    function shouldStartPanelDrag(path) {
        if (!path || !headElRef.current || !path.includes(headElRef.current)) return false;

        return !path.some((node) => {
            if (!node || node === headElRef.current || typeof node.matches !== "function") {
                return false;
            }
            return node.matches(
                "button, a, select, input, textarea, ul, li, [role='menuitem'], [data-no-panel-drag]"
            );
        });
    }

    function persistFloatingFrame(position, width, height) {
        const viewport = getViewportMetrics();
        displaySettingRef.current.floatingData.width = width / viewport.width;
        displaySettingRef.current.floatingData.height = height / viewport.height;
        displaySettingRef.current.floatingData.position = {
            x: position[0] / viewport.width,
            y: position[1] / viewport.height,
        };
        lastFloatingPosRef.current = { x: position[0], y: position[1] };
        userMovedRef.current = true;
    }

    function getSavedFloatingPosition(width, height) {
        const position = displaySettingRef.current.floatingData.position;
        if (!position || typeof position.x !== "number" || typeof position.y !== "number") {
            return null;
        }
        const viewport = getViewportMetrics();
        return clampFloatingPosition(
            [position.x * viewport.width, position.y * viewport.height],
            width,
            height
        );
    }

    function setDockPreview(position) {
        dragStateRef.current.dockCandidate = position;
        setHighlight((previous) => {
            if (
                previous.show === Boolean(position) &&
                previous.position === (position || "right")
            ) {
                return previous;
            }
            return {
                show: Boolean(position),
                position: position || "right",
            };
        });
    }

    function clearDockPreview() {
        dragStateRef.current.dockCandidate = null;
        setHighlight({ show: false, position: "right" });
    }

    function setPanelMotionState(state, duration = 260) {
        const panel = panelElRef.current;
        if (!panel) return;

        if (panelMotionTimerRef.current) {
            clearTimeout(panelMotionTimerRef.current);
            panelMotionTimerRef.current = 0;
        }

        if (state) panel.dataset.motion = state;
        else delete panel.dataset.motion;

        if (state && duration > 0) {
            panelMotionTimerRef.current = window.setTimeout(() => {
                if (panelElRef.current === panel && panel.dataset.motion === state) {
                    delete panel.dataset.motion;
                }
                panelMotionTimerRef.current = 0;
            }, duration);
        }
    }

    function openPanel() {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = 0;
        }
        setPanelMotionState("");
        lastOpenedAtRef.current = Date.now();
        setOpen(true);
    }

    function closePanel() {
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);

        const panel = panelElRef.current;
        if (!panel) {
            setOpen(false);
            return;
        }

        if (displaySettingRef.current.type === "fixed") {
            setPanelMotionState("closing", 170);
            closeTimerRef.current = window.setTimeout(() => {
                closeTimerRef.current = 0;
                setOpen(false);
            }, 170);
            return;
        }

        setPanelMotionState("closing", 170);
        closeTimerRef.current = window.setTimeout(() => {
            closeTimerRef.current = 0;
            setOpen(false);
        }, 170);
    }

    function writePanelFrame(frame, animate = false, duration = 260, easing = transitionEasing) {
        const panel = panelElRef.current;
        if (!panel) return;

        const nextFrame = {
            ...frameRef.current,
            ...frame,
        };
        frameRef.current = nextFrame;

        if (animate) {
            panel.style.transition = `transform ${duration}ms ${easing}, width ${duration}ms ${easing}, height ${duration}ms ${easing}, box-shadow ${duration}ms ${easing}, border-color ${duration}ms ${easing}, background-color ${duration}ms ${easing}`;
            window.setTimeout(() => {
                if (panelElRef.current === panel) panel.style.transition = "";
            }, duration + 60);
        } else if (panel.dataset.motion !== "detaching") {
            panel.style.transition = "";
        }

        panel.style.width = `${Math.round(nextFrame.width)}px`;
        panel.style.height = `${Math.round(nextFrame.height)}px`;
        panel.style.transform = `translate3d(${Math.round(nextFrame.x)}px, ${Math.round(
            nextFrame.y
        )}px, 0)`;
    }

    function setPanelFrame(frame, animate = false, duration = 260, easing = transitionEasing) {
        if (animate) {
            if (frameRafRef.current) {
                cancelAnimationFrame(frameRafRef.current);
                frameRafRef.current = 0;
                pendingFrameRef.current = null;
            }
            writePanelFrame(frame, true, duration, easing);
            return;
        }

        pendingFrameRef.current = {
            ...(pendingFrameRef.current || frameRef.current),
            ...frame,
        };
        frameRef.current = pendingFrameRef.current;

        if (frameRafRef.current) return;
        frameRafRef.current = requestAnimationFrame(() => {
            frameRafRef.current = 0;
            const nextFrame = pendingFrameRef.current;
            pendingFrameRef.current = null;
            writePanelFrame(nextFrame);
        });
    }

    function getAnchorPosition(width, height) {
        let base = null;
        if (contentRef.current.position && Array.isArray(contentRef.current.position)) {
            base = [contentRef.current.position[0], contentRef.current.position[1]];
        } else if (lastAnchorPosRef.current) {
            base = [lastAnchorPosRef.current[0], lastAnchorPosRef.current[1]];
        }
        if (!base) return null;

        const XBias = 20;
        const YBias = 20;
        const threshold = height / 4;
        let position = [base[0], base[1]];
        if (position[0] + width > window.innerWidth) position[0] = position[0] - width - XBias;
        if (position[1] + height > window.innerHeight + threshold) {
            const nextY = position[1] - height - YBias + threshold;
            position[1] = nextY < 0 ? 0 : nextY;
        }
        return clampFloatingPosition([position[0] + XBias, position[1] + YBias], width, height);
    }

    /**
     * Keep the native window frame visible after viewport changes.
     */
    const updateBounds = useCallback(async () => {
        if (!panelElRef.current || displaySettingRef.current.type !== "floating") return;
        const frame = frameRef.current;
        if (!frame.width || !frame.height) return;
        const [x, y] = clampFloatingPosition([frame.x, frame.y], frame.width, frame.height);
        if (x !== frame.x || y !== frame.y) {
            setPanelFrame({ x, y }, true, 180);
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
                openPanel();
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
                openPanel();
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
                openPanel();
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
                    closePanel();
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

    function getEventPath(event) {
        return event.path || (event.composedPath && event.composedPath()) || [];
    }

    function setupNativeWindowController(panelEl) {
        let interaction = null;

        const endInteraction = () => {
            interaction = null;
            clearDockPreview();
            document.removeEventListener("pointermove", onPointerMove, true);
            document.removeEventListener("pointerup", onPointerUp, true);
            document.removeEventListener("pointercancel", onPointerCancel, true);
        };

        const attachDocumentPointerListeners = () => {
            document.addEventListener("pointermove", onPointerMove, true);
            document.addEventListener("pointerup", onPointerUp, true);
            document.addEventListener("pointercancel", onPointerCancel, true);
        };

        const getFloatingFrameForPointer = (event, anchor) => {
            const floatingSize = getFloatingSizeFromSetting();
            const pointerXRatio = anchor?.pointerXRatio ?? 0.5;
            const pointerYOffset = anchor?.pointerYOffset ?? 32;
            const [x, y] = clampFloatingPosition(
                [
                    event.clientX - floatingSize.width * pointerXRatio,
                    event.clientY - pointerYOffset,
                ],
                floatingSize.width,
                floatingSize.height
            );

            return {
                x,
                y,
                width: floatingSize.width,
                height: floatingSize.height,
            };
        };

        const applyDetachResizeTransition = () => {
            panelEl.style.transition = `width ${DetachResizeMotion}, height ${DetachResizeMotion}, box-shadow ${DetachResizeMotion}, filter ${DetachResizeMotion}, border-color ${DetachResizeMotion}`;
        };

        const beginDrag = (event) => {
            event.preventDefault();
            event.stopPropagation();

            const startType = displaySettingRef.current.type;
            const startFrame = { ...frameRef.current };
            const floatingSize = getFloatingSizeFromSetting();
            const pointerAnchor = {
                pointerXRatio: clamp(
                    (event.clientX - startFrame.x) / Math.max(1, startFrame.width),
                    0.18,
                    0.82
                ),
                pointerYOffset: clamp(
                    event.clientY - startFrame.y,
                    18,
                    Math.min(64, floatingSize.height * 0.32)
                ),
            };
            if (startType !== "fixed") setPanelMotionState("dragging", 0);

            interaction = {
                mode: "drag",
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startFrame,
                latestFrame: startFrame,
                pointerAnchor,
                undocked: startType !== "fixed",
            };
            dragStateRef.current = {
                startType,
                startFixedPosition: displaySettingRef.current.fixedData.position,
                dockCandidate: null,
                samples: [],
            };
            recordDragSample(event, [frameRef.current.x, frameRef.current.y]);
            clearDockPreview();
            panelEl.setPointerCapture?.(event.pointerId);
            attachDocumentPointerListeners();
        };

        const beginResize = (event) => {
            event.preventDefault();
            event.stopPropagation();
            interaction = {
                mode: "resize",
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startFrame: { ...frameRef.current },
                latestFrame: { ...frameRef.current },
            };
            panelEl.setPointerCapture?.(event.pointerId);
            attachDocumentPointerListeners();
        };

        const onPointerDown = (event) => {
            if (event.button !== 0) return;
            const path = getEventPath(event);
            if (path.some((node) => node?.dataset?.panelResizeHandle)) {
                beginResize(event);
                return;
            }
            if (shouldStartPanelDrag(path)) beginDrag(event);
        };

        const onPointerMove = (event) => {
            if (!interaction || event.pointerId !== interaction.pointerId) return;

            const dx = event.clientX - interaction.startClientX;
            const dy = event.clientY - interaction.startClientY;
            const startFrame = interaction.startFrame;

            if (interaction.mode === "drag") {
                if (dragStateRef.current.startType === "fixed" && !interaction.undocked) {
                    if (Math.hypot(dx, dy) < 3) return;
                    interaction.undocked = true;
                    displaySettingRef.current.type = "floating";
                    setDisplayType("floating");
                    setPanelMotionState("detaching", 240);
                    applyDetachResizeTransition();
                    removeFixedPanel();
                }

                if (dragStateRef.current.startType === "fixed") {
                    const nextFrame = getFloatingFrameForPointer(event, interaction.pointerAnchor);
                    interaction.startFrame = nextFrame;
                    interaction.latestFrame = nextFrame;
                    setPanelFrame(nextFrame);
                    recordDragSample(event, [nextFrame.x, nextFrame.y]);
                    setDockPreview(getDockCandidate([nextFrame.x, nextFrame.y], nextFrame.width));
                    return;
                }

                const [x, y] = clampFloatingPosition(
                    [startFrame.x + dx, startFrame.y + dy],
                    startFrame.width,
                    startFrame.height
                );
                const nextFrame = {
                    ...startFrame,
                    x,
                    y,
                };
                interaction.latestFrame = nextFrame;
                setPanelFrame(nextFrame);
                recordDragSample(event, [x, y]);
                setDockPreview(getDockCandidate([x, y], startFrame.width));
                return;
            }

            if (interaction.mode === "resize") {
                const viewport = getViewportMetrics();
                const width = clamp(
                    startFrame.width + dx,
                    Math.min(FloatingWidthMin, viewport.width - FloatingMargin * 2),
                    viewport.width - startFrame.x - FloatingMargin
                );
                const height = clamp(
                    startFrame.height + dy,
                    Math.min(FloatingHeightMin, viewport.height - FloatingMargin * 2),
                    viewport.height - startFrame.y - FloatingMargin
                );
                const nextFrame = {
                    ...startFrame,
                    width,
                    height,
                };
                interaction.latestFrame = nextFrame;
                setPanelFrame(nextFrame);
            }
        };

        const finishDrag = () => {
            const frame = interaction.latestFrame;
            clearDockPreview();

            if (dragStateRef.current.startType === "fixed" && !interaction.undocked) {
                endInteraction();
                return;
            }

            const dockPosition = getReleaseDockCandidate([frame.x, frame.y], frame.width);
            if (dockPosition) {
                displaySettingRef.current.fixedData.position = dockPosition;
                displaySettingRef.current.fixedData.width = clamp(
                    frame.width / getViewportMetrics().width,
                    0.16,
                    0.42
                );
                displaySettingRef.current.type = "fixed";
                displaySettingRef.current.floatingData.position = null;
                userMovedRef.current = false;
                setPanelMotionState("docking", 260);
                showFixedPanel(true, { slideIn: false, duration: 260 });
                updateDisplaySetting();
                endInteraction();
                return;
            }

            const [x, y] = clampFloatingPosition([frame.x, frame.y], frame.width, frame.height);
            const finalFrame = { ...frame, x, y };
            displaySettingRef.current.type = "floating";
            persistFloatingFrame([x, y], finalFrame.width, finalFrame.height);
            setPanelMotionState("settling", 260);
            setPanelFrame(finalFrame, true, 220);
            updateDisplaySetting();
            endInteraction();
        };

        const finishResize = () => {
            const frame = interaction.latestFrame;
            const [x, y] = clampFloatingPosition([frame.x, frame.y], frame.width, frame.height);
            const finalFrame = { ...frame, x, y };
            displaySettingRef.current.type = "floating";
            persistFloatingFrame([x, y], finalFrame.width, finalFrame.height);
            setPanelMotionState("settling", 240);
            setPanelFrame(finalFrame, true, 180);
            updateDisplaySetting();
            endInteraction();
        };

        const onPointerUp = (event) => {
            if (!interaction || event.pointerId !== interaction.pointerId) return;
            panelEl.releasePointerCapture?.(event.pointerId);
            if (interaction.mode === "drag") finishDrag(event);
            else finishResize(event);
        };

        const onPointerCancel = (event) => {
            if (!interaction || event.pointerId !== interaction.pointerId) return;
            panelEl.releasePointerCapture?.(event.pointerId);
            setPanelMotionState("settling", 220);
            setPanelFrame(interaction.startFrame, true, 180);
            endInteraction();
        };

        panelEl.addEventListener("pointerdown", onPointerDown);

        return () => {
            if (frameRafRef.current) {
                cancelAnimationFrame(frameRafRef.current);
                frameRafRef.current = 0;
                pendingFrameRef.current = null;
            }
            if (closeTimerRef.current) {
                clearTimeout(closeTimerRef.current);
                closeTimerRef.current = 0;
            }
            if (panelMotionTimerRef.current) {
                clearTimeout(panelMotionTimerRef.current);
                panelMotionTimerRef.current = 0;
            }
            endInteraction();
            setPanelMotionState("");
            panelEl.removeEventListener("pointerdown", onPointerDown);
        };
    }

    /**
     * When status of result panel is changed(open or close), this function will be triggered.
     */
    const onDisplayStatusChange = useCallback((panelEl) => {
        panelElRef.current = panelEl;

        /* If panel is closed */
        if (!panelEl) {
            windowControllerRef.current?.();
            windowControllerRef.current = null;
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

        windowControllerRef.current?.();
        windowControllerRef.current = setupNativeWindowController(panelEl);
        setMoveableReady(true);
        panelEl.style.opacity = "0";
        requestAnimationFrame(showPanel);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Update drag bounds when users scroll the page
    useEvent("scroll", updateBounds, window);

    // Update the drag bounds and size when the size of window has changed
    useEvent("resize", windowResizeHandler, window);

    useClickAway(containerElRef, () => {
        // The panel will be closed if users click outside of the it with the panelFix option closed.
        const openedRecently = Date.now() - lastOpenedAtRef.current < 500;
        if (contentTypeRef.current === "LOADING" || openedRecently) return;
        if (!panelFix) {
            closePanel();
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
            const { width, height } = getFloatingSizeFromSetting();

            // iPadOS-style memory: once the user moves the panel, reopen it in that frame.
            const savedPosition = getSavedFloatingPosition(width, height);
            const anchorPosition = getAnchorPosition(width, height);
            if (savedPosition) {
                position = savedPosition;
            } else if (userMovedRef.current && lastFloatingPosRef.current) {
                position = clampFloatingPosition(
                    [lastFloatingPosRef.current.x, lastFloatingPosRef.current.y],
                    width,
                    height
                );
            } else if (anchorPosition) {
                position = anchorPosition;
            } else {
                const viewport = getViewportMetrics();
                position = clampFloatingPosition(
                    [viewport.width - width - FloatingMargin, FloatingMargin],
                    width,
                    height
                );
            }

            setDisplayType("floating");
            writePanelFrame({
                x: position[0],
                y: position[1],
                width,
                height,
            });
            requestAnimationFrame(() => {
                if (panelElRef.current) panelElRef.current.style.opacity = "";
                setPanelMotionState("floating-opening", 210);
            });
        } else {
            showFixedPanel(true);
        }
    }

    /**
     * Show the result panel in the floating type.
     */
    function showFloatingPanel() {
        if (!panelElRef.current) return;
        setDisplayType("floating");

        let { width: panelWidth, height: panelHeight } = getFloatingSizeFromSetting();

        /* Fit the panel to the content size */
        if (
            (contentTypeRef.current === "RESULT" && !contentRef.current?.isStreaming) ||
            contentTypeRef.current === "ERROR"
        ) {
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

        const frame = frameRef.current;
        const [x, y] = clampFloatingPosition(
            [frame.x || FloatingMargin, frame.y || FloatingMargin],
            panelWidth,
            panelHeight
        );
        setPanelFrame({
            x,
            y,
            width: panelWidth,
            height: panelHeight,
        });
    }

    /**
     * Show the result panel in the fixed type.
     */
    function showFixedPanel(animate = false, options = {}) {
        setDisplayType("fixed");
        const viewport = getViewportMetrics();
        const width = getFixedPanelWidth(viewport);
        const height = viewport.height - SlideOverMargin * 2;
        let offsetLeft = SlideOverMargin;
        if (displaySettingRef.current.fixedData.position === "right")
            offsetLeft = viewport.width - width - SlideOverMargin;

        const targetFrame = {
            width,
            height,
            x: offsetLeft,
            y: SlideOverMargin,
        };

        Promise.resolve().then(async () => {
            if (documentBodyCSS) {
                resizePageFlag.current = true;
                await removeFixedPanel();
            }
            resizePageFlag.current = false;

            const slideIn = options.slideIn ?? animate;
            const duration = options.duration ?? 210;
            const easing = options.easing ?? transitionEasing;

            if (slideIn) {
                writePanelFrame(targetFrame);
                requestAnimationFrame(() => {
                    if (panelElRef.current) panelElRef.current.style.opacity = "";
                    setPanelMotionState("floating-opening", duration);
                });
                return;
            }

            if (panelElRef.current) panelElRef.current.style.opacity = "";
            move(
                targetFrame.width,
                targetFrame.height,
                targetFrame.x,
                targetFrame.y,
                animate,
                duration,
                easing
            );
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
    function move(
        width,
        height,
        left,
        top,
        animate = false,
        duration = 260,
        easing = transitionEasing
    ) {
        setPanelFrame(
            {
                width,
                height,
                x: left,
                y: top,
            },
            animate,
            duration,
            easing
        );
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
                            position: null,
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
                        const position = displaySettingRef.current.floatingData.position;
                        if (
                            position &&
                            (typeof position.x !== "number" || typeof position.y !== "number")
                        ) {
                            displaySettingRef.current.floatingData.position = null;
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
                        data-display-type={displayType}
                        $isTranslating={contentType === "LOADING" || content?.isStreaming}
                        data-testid="Panel"
                    >
                        {
                            // Only show the panel's content when the panel is movable.
                            moveableReady && (
                                <Fragment>
                                    <Head ref={headElRef} data-testid="Head">
                                        <SourceOption
                                            role="button"
                                            title={getI18nMessage(
                                                `${currentTranslator}Short`,
                                                currentTranslator
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
                                            {availableTranslators?.map((translator) => {
                                                const description = getI18nMessage(
                                                    `${translator}Description`
                                                );
                                                return (
                                                    <Dropdown.Item
                                                        role="button"
                                                        key={translator}
                                                        eventKey={translator}
                                                    >
                                                        <TranslatorOptionContent>
                                                            <TranslatorOptionHeader>
                                                                <TranslatorOptionName>
                                                                    {getI18nMessage(
                                                                        translator,
                                                                        translator
                                                                    )}
                                                                </TranslatorOptionName>
                                                            </TranslatorOptionHeader>
                                                            {description && (
                                                                <TranslatorOptionDescription>
                                                                    {description}
                                                                </TranslatorOptionDescription>
                                                            )}
                                                        </TranslatorOptionContent>
                                                    </Dropdown.Item>
                                                );
                                            })}
                                        </SourceOption>
                                        <HeadIcons data-no-panel-drag="true">
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
                                                onClick={closePanel}
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
                                    {displayType === "floating" && (
                                        <ResizeHandle
                                            data-panel-resize-handle="bottom-right"
                                            aria-hidden="true"
                                        />
                                    )}
                                </Fragment>
                            )
                        }
                    </Panel>
                </root.div>
            )}
            {highlight.show && (
                <Highlight
                    $position={highlight.position}
                    style={{
                        width: getFixedPanelWidth(),
                        [highlight.position]: SlideOverMargin,
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
    /* iOS 26 Liquid Glass tokens — light-dark() auto-flips for theme. */
    color-scheme: light dark;
    --et-outline-color: light-dark(rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.08));
    --et-glass-top: light-dark(rgba(255, 255, 255, 0.76), rgba(28, 28, 30, 0.78));
    --et-glass-bottom: light-dark(rgba(255, 255, 255, 0.66), rgba(28, 28, 30, 0.66));
    --et-glass-sheen: light-dark(rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0.08));

    display: flex;
    flex-direction: column;
    flex-wrap: nowrap;
    justify-content: flex-start;
    align-items: stretch;
    position: fixed;
    top: 0;
    left: 0;
    z-index: ${MaxZIndex};
    border-radius: ${PanelRadius};
    overflow: hidden;
    isolation: isolate;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 8px 28px rgba(0, 0, 0, 0.18),
        0 32px 64px -16px rgba(0, 0, 0, 0.22);
    background: var(--et-glass-top);
    background-clip: padding-box;
    backdrop-filter: blur(36px) saturate(190%);
    -webkit-backdrop-filter: blur(36px) saturate(190%);
    opacity: 1;
    scale: 1;
    transform-origin: 50% 24px;
    will-change: transform, scale, opacity, filter, width, height;

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

    transition: background-color ${MotionStandard}, box-shadow ${MotionSnappy},
        filter ${MotionSnappy}, color ${MotionStandard}, opacity ${MotionFast},
        border-color ${MotionFast}, scale ${MotionSnappy};

    border: 1px solid var(--et-outline-color);

    &[data-display-type="fixed"] {
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4), 0 12px 34px rgba(0, 0, 0, 0.2),
            0 32px 64px -16px rgba(0, 0, 0, 0.24);
    }

    &[data-motion="undocking"] {
        border-color: rgba(211, 227, 253, 0.9);
        box-shadow: 0 32px 74px rgba(30, 47, 72, 0.24), 0 14px 28px rgba(30, 47, 72, 0.14),
            inset 0 1px 0 rgba(255, 255, 255, 0.9);
        filter: saturate(1.08) brightness(1.02);
    }

    &[data-motion="dragging"] {
        border-color: rgba(255, 255, 255, 0.82);
        box-shadow: 0 34px 78px rgba(30, 47, 72, 0.26), 0 16px 32px rgba(30, 47, 72, 0.12),
            inset 0 1px 0 rgba(255, 255, 255, 0.9);
        filter: saturate(1.1);
    }

    &[data-motion="detaching"] {
        border-color: rgba(255, 255, 255, 0.86);
        box-shadow: 0 34px 78px rgba(30, 47, 72, 0.24), 0 16px 32px rgba(30, 47, 72, 0.11),
            inset 0 1px 0 rgba(255, 255, 255, 0.9);
        filter: saturate(1.08) brightness(1.015);
    }

    &[data-motion="docking"],
    &[data-motion="settling"] {
        box-shadow: 0 26px 66px rgba(30, 47, 72, 0.2), 0 9px 20px rgba(30, 47, 72, 0.11),
            inset 0 1px 0 rgba(255, 255, 255, 0.84);
        filter: saturate(1.04);
    }

    &[data-motion="floating-opening"] {
        animation: et-floating-spotlight-in ${MotionFloatingSpotlightIn} both;
    }

    &[data-motion="closing"] {
        opacity: 0;
        scale: 0.98;
        filter: blur(10px) saturate(0.88) brightness(1.04);
        box-shadow: 0 10px 28px rgba(30, 47, 72, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.62);
        transition: opacity ${MotionFloatingSpotlightOut}, scale ${MotionFloatingSpotlightOut},
            filter ${MotionFloatingSpotlightOut}, box-shadow ${MotionFloatingSpotlightOut},
            border-color ${MotionFloatingSpotlightOut};
    }

    @keyframes et-floating-spotlight-in {
        from {
            opacity: 0;
            scale: 0.98;
            filter: blur(12px) saturate(0.86) brightness(1.04);
        }

        to {
            opacity: 1;
            scale: 1;
            filter: blur(0) saturate(1) brightness(1);
        }
    }

    &:before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(180deg, var(--et-glass-sheen), transparent 34%);
        opacity: 0.58;
    }

    /* Dark mode: --et-glass-* tokens above already flip via light-dark(). The
       text color also adapts via the css var color-scheme matching. */
    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurface};
    }
`;

const Head = styled.div`
    min-height: 50px;
    padding: 6px 10px 6px 12px;
    display: flex;
    justify-content: flex-start;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    min-width: 0;
    overflow: visible;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.72);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.68), rgba(248, 250, 253, 0.28));
    border-radius: inherit;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    transition: background ${MotionStandard}, border-color ${MotionStandard};

    @media (prefers-color-scheme: dark) {
        border-bottom-color: ${DarkOutline};
        background: linear-gradient(180deg, rgba(32, 38, 45, 0.7), rgba(27, 32, 38, 0.5));
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
    width: 34px;
    height: 34px;
    margin: 0 3px;
    background-color: rgba(241, 244, 248, 0.66);
    backdrop-filter: blur(12px) saturate(150%);
    -webkit-backdrop-filter: blur(12px) saturate(150%);
    border-radius: 999px;
    box-shadow: 0 4px 12px rgba(30, 47, 72, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.68);
    transition: transform ${MotionSnappy}, background-color 0.2s, box-shadow 0.2s, color 0.2s;
    transform: scale(1);

    svg {
        fill: #5f6368;
        width: 18px;
        height: 18px;
        display: block;
        transition: fill 0.2s ease, transform 0.2s ease;
    }

    &:hover {
        background-color: rgba(211, 227, 253, 0.82);
        transform: scale(1.1);
        box-shadow: 0 4px 8px rgba(11, 87, 208, 0.15);
    }

    &:hover svg {
        fill: ${ColorPrimary};
    }

    &:active {
        transform: scale(0.92);
        box-shadow: 0 1px 2px rgba(11, 87, 208, 0.1);
    }

    @media (prefers-color-scheme: dark) {
        background-color: #242a31;
        box-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);

        svg {
            fill: ${DarkOnSurfaceVariant};
        }

        &:hover {
            background-color: #2e3742;
            box-shadow: 0 4px 8px rgba(168, 199, 250, 0.2);
        }

        &:hover svg {
            fill: ${DarkPrimary};
        }

        &:active {
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
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
    background: linear-gradient(180deg, rgba(241, 244, 248, 0.34), rgba(248, 250, 253, 0.16)),
        rgba(248, 250, 253, 0.12);
    flex-grow: 1;
    flex-shrink: 1;
    word-break: break-word;
    transition: background ${MotionStandard};

    @media (prefers-color-scheme: dark) {
        background: linear-gradient(180deg, rgba(36, 42, 49, 0.65), rgba(27, 32, 38, 0.35)),
            rgba(21, 25, 29, 0.35);
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
    min-height: 36px;
    padding: 0 11px;
    outline: none;
    transition: background-color ${MotionFast}, color ${MotionFast};

    @media (prefers-color-scheme: dark) {
        color: ${DarkPrimary};
        background-color: #1f3b68;
    }

    ul {
        min-width: 260px;
        max-width: min(320px, calc(100vw - 32px));
        text-align: left;
        text-align-last: left;
    }
`;

const ResizeHandle = styled.div`
    position: absolute;
    right: 6px;
    bottom: 6px;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    cursor: nwse-resize;
    touch-action: none;
    background: radial-gradient(circle at 70% 70%, rgba(11, 87, 208, 0.24), rgba(11, 87, 208, 0));
    opacity: 0.72;
    transition: opacity ${MotionFast}, transform ${MotionSnappy};

    &:after {
        content: "";
        position: absolute;
        right: 5px;
        bottom: 5px;
        width: 9px;
        height: 9px;
        border-right: 2px solid rgba(11, 87, 208, 0.55);
        border-bottom: 2px solid rgba(11, 87, 208, 0.55);
        border-radius: 1px;
    }

    &:hover {
        opacity: 1;
        transform: scale(1.08);
    }

    @media (prefers-color-scheme: dark) {
        background: radial-gradient(
            circle at 70% 70%,
            rgba(168, 199, 250, 0.24),
            rgba(168, 199, 250, 0)
        );

        &:after {
            border-color: rgba(168, 199, 250, 0.62);
        }
    }
`;

const TranslatorOptionContent = styled.div`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    min-width: 0;
    width: 100%;
    text-align: left;
    text-align-last: left;
`;

const TranslatorOptionHeader = styled.div`
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
`;

const TranslatorOptionName = styled.span`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
    text-align-last: left;
    white-space: nowrap;
`;

const TranslatorOptionDescription = styled.span`
    display: block;
    width: 100%;
    color: #5f6368;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.35;
    text-align: left;
    text-align-last: left;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: keep-all;

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurfaceVariant};
    }
`;

const Highlight = styled.div`
    --et-guide-slide-offset: ${(props) => (props.$position === "left" ? "-10px" : "10px")};
    background: rgba(211, 227, 253, 0.34);
    backdrop-filter: blur(16px) saturate(150%);
    -webkit-backdrop-filter: blur(16px) saturate(150%);
    position: fixed;
    top: ${SlideOverMargin}px;
    bottom: ${SlideOverMargin}px;
    z-index: ${MaxZIndex};
    pointer-events: none;
    border-radius: ${PanelRadius};
    border: 1px solid rgba(255, 255, 255, 0.62);
    box-shadow: 0 18px 48px rgba(30, 47, 72, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.58);
    transform-origin: ${(props) => (props.$position === "left" ? "left center" : "right center")};
    animation: et-dock-guide-enter 180ms cubic-bezier(0.2, 0, 0, 1) both;
    will-change: opacity, transform, filter;

    @keyframes et-dock-guide-enter {
        from {
            opacity: 0;
            transform: translateX(var(--et-guide-slide-offset)) scaleX(0.975);
            filter: blur(10px) saturate(0.92);
        }

        to {
            opacity: 1;
            transform: translateX(0) scaleX(1);
            filter: blur(0) saturate(1);
        }
    }

    @media (prefers-color-scheme: dark) {
        background: rgba(31, 59, 104, 0.34);
        border-color: rgba(255, 255, 255, 0.12);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }
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
