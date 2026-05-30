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
            <div class="glass-loader" aria-hidden="true">
                <span class="glass-loader__bead glass-loader__bead--one" />
                <span class="glass-loader__bead glass-loader__bead--two" />
                <span class="glass-loader__bead glass-loader__bead--three" />
                <div class="glass-loader__ambient" />
            </div>
        </LoadingEffect>
    );
}

const LoadingEffect = styled.div`
    width: 100%;
    min-height: 152px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 28px 0;

    .glass-loader {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        width: 120px;
        height: 60px;
        border-radius: 20px;
        background: transparent;
        animation: et-loader-arrive 280ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }

    .glass-loader__bead {
        position: relative;
        z-index: 2;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: linear-gradient(135deg, rgba(0, 102, 204, 0.86), rgba(0, 102, 204, 0.82));
        box-shadow: inset 1px 1.5px 0 rgba(255, 255, 255, 0.45),
            inset -1px -1px 0 rgba(0, 0, 0, 0.08), 0 8px 18px rgba(0, 102, 204, 0.16);
        transform: translateY(0) scale(0.88);
        opacity: 0.78;
        animation: et-loader-bead 1.4s infinite ease-in-out;
    }

    .glass-loader__bead--one {
        animation-delay: 0s;
    }

    .glass-loader__bead--two {
        animation-delay: 0.16s;
        background: linear-gradient(135deg, rgba(0, 102, 204, 0.86), rgba(0, 102, 204, 0.82));
        box-shadow: inset 1px 1.5px 0 rgba(255, 255, 255, 0.45),
            inset -1px -1px 0 rgba(0, 0, 0, 0.08), 0 8px 18px rgba(0, 102, 204, 0.16);
    }

    .glass-loader__bead--three {
        animation-delay: 0.32s;
        background: linear-gradient(135deg, rgba(0, 102, 204, 0.86), rgba(0, 102, 204, 0.82));
        box-shadow: inset 1px 1.5px 0 rgba(255, 255, 255, 0.45),
            inset -1px -1px 0 rgba(0, 0, 0, 0.08), 0 8px 18px rgba(0, 102, 204, 0.16);
    }

    .glass-loader__ambient {
        position: absolute;
        z-index: 1;
        inset: 4px 12px;
        border-radius: 999px;
        background: radial-gradient(
            circle,
            rgba(0, 102, 204, 0.12) 0%,
            rgba(0, 102, 204, 0.05) 50%,
            transparent 80%
        );
        filter: blur(12px);
        animation: et-loader-ambient 1.4s ease-in-out infinite alternate;
    }

    @keyframes et-loader-arrive {
        from {
            opacity: 0;
            transform: translateY(6px) scale(0.96);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }

    @keyframes et-loader-bead {
        0%,
        100% {
            transform: translateY(0) scale(0.88);
            opacity: 0.7;
        }
        40% {
            transform: translateY(-8px) scale(1.12);
            opacity: 1;
            filter: brightness(1.08);
        }
        70% {
            transform: translateY(2px) scale(0.92);
            opacity: 0.8;
        }
    }

    @keyframes et-loader-ambient {
        0% {
            transform: scale(0.9);
            opacity: 0.5;
        }
        100% {
            transform: scale(1.15);
            opacity: 0.92;
        }
    }

    @media (prefers-color-scheme: dark) {
        .glass-loader__bead {
            background: linear-gradient(
                135deg,
                rgba(41, 151, 255, 0.86),
                rgba(147, 216, 193, 0.82)
            );
            box-shadow: inset 1px 1.5px 0 rgba(255, 255, 255, 0.25),
                inset -1px -1px 0 rgba(0, 0, 0, 0.2), 0 8px 18px rgba(41, 151, 255, 0.18);
        }

        .glass-loader__bead--two {
            background: linear-gradient(
                135deg,
                rgba(147, 216, 193, 0.86),
                rgba(41, 151, 255, 0.82)
            );
            box-shadow: inset 1px 1.5px 0 rgba(255, 255, 255, 0.25),
                inset -1px -1px 0 rgba(0, 0, 0, 0.2), 0 8px 18px rgba(147, 216, 193, 0.18);
        }

        .glass-loader__bead--three {
            background: linear-gradient(
                135deg,
                rgba(41, 151, 255, 0.86),
                rgba(147, 216, 193, 0.82)
            );
            box-shadow: inset 1px 1.5px 0 rgba(255, 255, 255, 0.25),
                inset -1px -1px 0 rgba(0, 0, 0, 0.2), 0 8px 18px rgba(41, 151, 255, 0.18);
        }

        .glass-loader__ambient {
            background: radial-gradient(
                circle,
                rgba(41, 151, 255, 0.16) 0%,
                rgba(147, 216, 193, 0.06) 50%,
                transparent 80%
            );
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .glass-loader,
        .glass-loader__bead,
        .glass-loader__ambient {
            animation-duration: 1ms !important;
            animation-iteration-count: 1 !important;
        }
    }
`;
