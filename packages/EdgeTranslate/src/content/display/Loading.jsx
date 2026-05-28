/** @jsx h */
import { h } from "preact";
import { useEffect, useRef } from "preact/hooks";
import styled from "styled-components";
import { ContentWrapperCenterClassName } from "./Panel.jsx";

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
            <div class="expressive-loader" aria-hidden="true">
                <span class="expressive-loader__bead expressive-loader__bead--one" />
                <span class="expressive-loader__bead expressive-loader__bead--two" />
                <span class="expressive-loader__bead expressive-loader__bead--three" />
                <span class="expressive-loader__bead expressive-loader__bead--four" />
                <span class="expressive-loader__glide" />
            </div>
        </LoadingEffect>
    );
}

const LoadingEffect = styled.div`
    --et-loader-primary: #0b57d0;
    --et-loader-secondary: #146c43;
    --et-loader-tertiary: #7a4d00;
    --et-loader-surface: rgba(255, 255, 255, 0.72);
    --et-loader-track: rgba(211, 227, 253, 0.58);

    width: 100%;
    min-height: 152px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 28px 0;

    .expressive-loader {
        width: 92px;
        height: 46px;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        border-radius: 999px;
        background: radial-gradient(circle at 30% 22%, rgba(255, 255, 255, 0.94), transparent 38%),
            linear-gradient(145deg, rgba(255, 255, 255, 0.78), rgba(248, 250, 253, 0.42));
        box-shadow: 0 16px 38px rgba(30, 47, 72, 0.13), 0 4px 12px rgba(30, 47, 72, 0.07),
            inset 0 1px 0 rgba(255, 255, 255, 0.8);
        backdrop-filter: blur(18px) saturate(155%);
        -webkit-backdrop-filter: blur(18px) saturate(155%);
        animation: et-loader-arrive 180ms cubic-bezier(0.2, 0, 0, 1) both;
    }

    .expressive-loader:before {
        content: "";
        position: absolute;
        inset: 7px 10px;
        border-radius: 999px;
        background: var(--et-loader-track);
        opacity: 0.7;
    }

    .expressive-loader__bead {
        position: relative;
        z-index: 1;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--et-loader-primary);
        opacity: 0.46;
        transform: scale(0.78);
        animation: et-loader-bead 1080ms cubic-bezier(0.2, 0, 0, 1) infinite;
    }

    .expressive-loader__bead--two {
        background: var(--et-loader-secondary);
        animation-delay: 120ms;
    }

    .expressive-loader__bead--three {
        background: var(--et-loader-tertiary);
        animation-delay: 240ms;
    }

    .expressive-loader__bead--four {
        background: var(--et-loader-primary);
        animation-delay: 360ms;
    }

    .expressive-loader__glide {
        position: absolute;
        z-index: 2;
        left: 18px;
        top: 15px;
        width: 24px;
        height: 16px;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--et-loader-primary), #4c8df6);
        box-shadow: 0 4px 12px rgba(11, 87, 208, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.34);
        animation: et-loader-glide 1080ms cubic-bezier(0.2, 0, 0, 1) infinite;
    }

    @keyframes et-loader-arrive {
        from {
            opacity: 0;
            transform: translateY(3px) scale(0.97);
        }

        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }

    @keyframes et-loader-bead {
        0%,
        100% {
            opacity: 0.38;
            transform: scale(0.72);
        }

        50% {
            opacity: 0.82;
            transform: scale(1);
        }
    }

    @keyframes et-loader-glide {
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

    @media (prefers-color-scheme: dark) {
        --et-loader-primary: #a8c7fa;
        --et-loader-secondary: #81c995;
        --et-loader-tertiary: #fdd663;
        --et-loader-surface: rgba(32, 38, 45, 0.66);
        --et-loader-track: rgba(31, 59, 104, 0.56);

        .expressive-loader {
            background: radial-gradient(
                    circle at 30% 22%,
                    rgba(255, 255, 255, 0.14),
                    transparent 38%
                ),
                linear-gradient(145deg, rgba(35, 42, 50, 0.68), rgba(22, 27, 32, 0.34));
            box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42), 0 5px 14px rgba(0, 0, 0, 0.28),
                inset 0 1px 0 rgba(255, 255, 255, 0.08);
        }

        .expressive-loader__glide {
            background: linear-gradient(135deg, var(--et-loader-primary), #669df6);
            box-shadow: 0 4px 12px rgba(168, 199, 250, 0.22),
                inset 0 1px 0 rgba(255, 255, 255, 0.16);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .expressive-loader,
        .expressive-loader__bead,
        .expressive-loader__glide {
            animation-duration: 1ms !important;
            animation-iteration-count: 1 !important;
        }
    }
`;
