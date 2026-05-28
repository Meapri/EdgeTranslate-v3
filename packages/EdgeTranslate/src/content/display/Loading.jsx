/** @jsx h */
import { h } from "preact";
import { useEffect, useRef } from "preact/hooks";
import styled from "styled-components";
import { ContentWrapperCenterClassName } from "./Panel.jsx";

/**
 * iOS 26 Liquid Glass loading indicator.
 *
 * A translucent glass pill carrying three system-tinted beads that pulse
 * in sequence, with a system-blue capsule that glides above the row. The
 * outer surface uses the same backdrop blur recipe as the rest of the
 * iOS 26 design system, so the loader feels like part of the parent
 * Liquid Glass panel rather than a separate Material widget.
 */
export default function Loading() {
    const loadingElRef = useRef();

    useEffect(() => {
        const wrapperElement = loadingElRef.current?.parentElement?.parentElement;
        wrapperElement?.classList.add(ContentWrapperCenterClassName);
        return () => {
            wrapperElement?.classList.remove(ContentWrapperCenterClassName);
        };
    }, []);

    return (
        <LoadingEffect ref={loadingElRef} role="status" aria-live="polite" aria-label="Loading">
            <div class="ios-loader" aria-hidden="true">
                <span class="ios-loader__bead ios-loader__bead--one" />
                <span class="ios-loader__bead ios-loader__bead--two" />
                <span class="ios-loader__bead ios-loader__bead--three" />
                <span class="ios-loader__bead ios-loader__bead--four" />
                <span class="ios-loader__glide" />
            </div>
        </LoadingEffect>
    );
}

const iosEmphasized =
    "linear(0, 0.005, 0.018 1.5%, 0.066 3.7%, 0.171 7.5%, 0.346 13.6%, 0.547 21%, 0.722 29.4%, 0.853 38.4%, 0.937 47.7%, 0.978 56.8%, 0.997 67.4%, 1)";

const LoadingEffect = styled.div`
    color-scheme: light dark;
    --ios-loader-primary: light-dark(#007aff, #0a84ff);
    --ios-loader-secondary: light-dark(#34c759, #30d158);
    --ios-loader-tertiary: light-dark(#ff9500, #ff9f0a);
    --ios-loader-glass: light-dark(rgba(255, 255, 255, 0.76), rgba(28, 28, 30, 0.78));
    --ios-loader-stroke: light-dark(rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.08));
    --ios-loader-track: light-dark(rgba(0, 122, 255, 0.1), rgba(10, 132, 255, 0.18));

    width: 100%;
    min-height: 152px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 28px 0;

    .ios-loader {
        width: 96px;
        height: 46px;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border-radius: 9999px;
        background: var(--ios-loader-glass);
        border: 0.5px solid var(--ios-loader-stroke);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 8px 28px rgba(0, 0, 0, 0.12),
            0 32px 64px -16px rgba(0, 0, 0, 0.16);
        backdrop-filter: blur(36px) saturate(190%);
        -webkit-backdrop-filter: blur(36px) saturate(190%);
        animation: ios-loader-arrive 220ms ${iosEmphasized} both;
    }

    .ios-loader:before {
        content: "";
        position: absolute;
        inset: 7px 10px;
        border-radius: 9999px;
        background: var(--ios-loader-track);
    }

    .ios-loader__bead {
        position: relative;
        z-index: 1;
        width: 9px;
        height: 9px;
        border-radius: 9999px;
        background: var(--ios-loader-primary);
        opacity: 0.42;
        transform: scale(0.74);
        animation: ios-loader-bead 1100ms ${iosEmphasized} infinite;
    }

    .ios-loader__bead--two {
        background: var(--ios-loader-secondary);
        animation-delay: 120ms;
    }

    .ios-loader__bead--three {
        background: var(--ios-loader-tertiary);
        animation-delay: 240ms;
    }

    .ios-loader__bead--four {
        background: var(--ios-loader-primary);
        animation-delay: 360ms;
    }

    .ios-loader__glide {
        position: absolute;
        z-index: 2;
        left: 18px;
        top: 15px;
        width: 24px;
        height: 16px;
        border-radius: 9999px;
        background: var(--ios-loader-primary);
        box-shadow: 0 4px 12px color-mix(in oklab, var(--ios-loader-primary) 28%, transparent),
            inset 0 1px 0 rgba(255, 255, 255, 0.35);
        animation: ios-loader-glide 1080ms ${iosEmphasized} infinite;
    }

    @keyframes ios-loader-arrive {
        from {
            opacity: 0;
            transform: translateY(3px) scale(0.97);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }

    @keyframes ios-loader-bead {
        0%,
        100% {
            opacity: 0.4;
            transform: scale(0.72);
        }
        50% {
            opacity: 0.85;
            transform: scale(1);
        }
    }

    @keyframes ios-loader-glide {
        0%,
        100% {
            transform: translateX(0) scaleX(0.9);
        }
        45% {
            transform: translateX(32px) scaleX(1.16);
        }
        56% {
            transform: translateX(32px) scaleX(0.94);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .ios-loader,
        .ios-loader__bead,
        .ios-loader__glide {
            animation-duration: 1ms !important;
            animation-iteration-count: 1 !important;
        }
    }
`;
