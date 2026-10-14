/**
 * Brand marks for the providers the product integrates with (Lucide has no
 * brand icons). Each renders in the colours its brand ships: one-colour marks
 * (Anthropic, OpenAI, GitHub, Pi) use `currentColor` so they follow the theme;
 * full-colour marks (Modal, OpenCode) keep their own fills. Path
 * geometry is unaltered.
 *
 * These marks are trademarks of their owners and are not covered by this
 * repository's licence. They are shown only to identify the service a
 * control belongs to; see THIRD_PARTY_NOTICES.md.
 */
import { useId } from "react";

type BrandIconProps = { className?: string };

export function GitHubMark({ className }: BrandIconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * The Anthropic company symbol, used where the user picks an account. Every
 * viewBox in this file is cropped to its artwork so marks of different
 * providers agree in height beside text.
 */
export function AnthropicMark({ className }: BrandIconProps) {
  return (
    <svg className={className} viewBox="0 0 92 64" fill="currentColor" aria-hidden="true">
      <path d="M66.4915 0H52.5029L78.0115 64H92.0001L66.4915 0Z" />
      <path d="M26.08 0L0.571472 64H14.8343L20.0512 50.56H46.7374L51.9543 64H66.2172L40.7086 0H26.08ZM24.6647 38.6743L33.3943 16.1829L42.1239 38.6743H24.6647Z" />
    </svg>
  );
}

/** Anthropic's Clay, the Spark's colour, as a text colour for `ClaudeMark` to inherit. */
export const CLAUDE_CLAY_CLASS = "text-[#D97757]";

/** The Claude Spark, the mark for the model rather than the company. */
export function ClaudeMark({ className }: BrandIconProps) {
  return (
    <svg className={className} viewBox="0 0 94 94" fill="currentColor" aria-hidden="true">
      <path d="M18.7657 62.4437L37.1822 52.1167L37.4857 51.2122L37.1822 50.7085H36.2715L33.1852 50.5208L22.6615 50.2391L13.5545 49.8636L4.70044 49.3942L2.47428 48.9248L0.399902 46.1553L0.602281 44.794L2.47428 43.5266L5.15579 43.7613L11.0754 44.1837L19.98 44.794L26.4055 45.1695L35.9679 46.1553H37.4857L37.6881 45.545L37.1822 45.1695L36.7774 44.794L27.5692 38.5508L17.6021 31.9791L12.3908 28.1769L9.60812 26.2524L8.19147 24.4686L7.58433 20.5256L10.1141 17.7091L13.5545 17.9438L14.4146 18.1785L17.9056 20.8542L25.343 26.6279L35.0572 33.7629L36.4739 34.9364L37.0443 34.5514L37.1316 34.2792L36.4739 33.1996L31.212 23.6706L25.596 13.9539L23.0663 9.91695L22.4086 7.52296C22.1538 6.51831 22.0038 5.68714 22.0038 4.65957L24.8877 0.716544L26.5067 0.200195L30.4025 0.716544L32.0215 2.12477L34.4501 7.66379L38.3458 16.3478L44.4172 28.1769L46.188 31.6975L47.1493 34.9364L47.5035 35.9222H48.1106V35.3589L48.6166 28.6933L49.5273 20.5256L50.438 10.0108L50.7415 7.05356L52.2088 3.48605L55.1433 1.56148L57.42 2.64112L59.292 5.31674L59.039 7.05356L57.926 14.2824L55.7504 25.5952L54.3337 33.1996H55.1433L56.1046 32.2138L59.9497 27.1442L66.3752 19.0704L69.2085 15.8784L72.5478 12.3579L74.6728 10.668H78.7203L81.6548 15.0804L80.3394 19.6337L76.1906 24.8911L72.7502 29.3504L67.8172 35.9595L64.7562 41.2734L65.0307 41.7118L65.7681 41.6489L76.8989 39.255L82.9197 38.1753L90.1041 36.9549L93.3422 38.457L93.6963 40.006L92.4315 43.151L84.7411 45.0287L75.7353 46.8594L62.3244 50.0164L62.1759 50.1358L62.3512 50.3958L68.399 50.9432L70.9794 51.084H77.3037L89.0922 51.9759L92.1785 53.9944L93.9999 56.4822L93.6963 58.4068L88.9404 60.8008L82.5655 59.2987L67.6401 55.7312L62.5301 54.4638H61.8217V54.8862L66.0717 59.064L73.9139 66.1051L83.6786 75.2116L84.1845 77.4648L82.9197 79.2485L81.6042 79.0608L73.0032 72.5829L69.6639 69.6726L62.1759 63.3356H61.67V63.9928L63.3902 66.5276L72.5478 80.2812L73.0032 84.5059L72.3454 85.8672L69.9675 86.7121L67.3871 86.2427L61.9735 78.6852L56.4587 70.2359L52.0064 62.6315L51.4687 62.971L48.8189 91.2654L47.6047 92.7206L44.7714 93.8002L42.3934 92.0164L41.1286 89.1061L42.3934 83.3324L43.9113 75.8219L45.1255 69.8604L46.2386 62.4437L46.9184 59.9661L46.8583 59.8003L46.3153 59.8916L40.7238 67.5603L32.2239 79.0608L25.4948 86.2427L23.8758 86.8999L21.0931 85.4447L21.3461 82.863L22.9145 80.5629L32.2239 68.7338L37.8399 61.3641L41.4594 57.1337L41.4242 56.5218L41.2244 56.5048L16.489 72.6299L12.0873 73.1932L10.1647 71.4094L10.4176 68.4991L11.3283 67.5603L18.7657 62.4437Z" />
    </svg>
  );
}

/**
 * OpenCode's mark. It ships light and dark two-colour variants, so both are
 * drawn and the theme shows one (`.oncue-mark-light` / `.oncue-mark-dark` in
 * `globals.css`). The published mask and clip are omitted so no document-wide
 * id is defined.
 */
export function OpenCodeMark({ className }: BrandIconProps) {
  const outer = "M180 60H60V240H180V60ZM240 300H0V0H240V300Z";
  const inner = "M180 240H60V120H180V240Z";
  return (
    <>
      <svg
        className={className === undefined ? "oncue-mark-light" : `${className} oncue-mark-light`}
        viewBox="0 0 240 300"
        fill="none"
        aria-hidden="true"
      >
        <path d={inner} fill="#CFCECD" />
        <path d={outer} fill="#211E1E" />
      </svg>
      <svg
        className={className === undefined ? "oncue-mark-dark" : `${className} oncue-mark-dark`}
        viewBox="0 0 240 300"
        fill="none"
        aria-hidden="true"
      >
        <path d={inner} fill="#4B4646" />
        <path d={outer} fill="#F1ECEC" />
      </svg>
    </>
  );
}

/** Pi's mark, a one-colour mark that inherits `currentColor`. */
export function PiMark({ className }: BrandIconProps) {
  return (
    <svg className={className} viewBox="0 0 560 560" fill="currentColor" aria-hidden="true">
      <path d="M420 280H280V140H0V0H420V280Z" />
      <path d="M560 560H420V280H560V560Z" />
      <path d="M140 560H0V140H140V280H280V420H140V560Z" />
    </svg>
  );
}

/** OpenAI's Blossom, cropped from the exported 716 square to its artwork. */
export function OpenAIMark({ className }: BrandIconProps) {
  return (
    <svg className={className} viewBox="172 172 372 372" fill="currentColor" aria-hidden="true">
      <path d="M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z" />
    </svg>
  );
}

/**
 * Modal's full-colour mark; keep its greens on both themes. SVG ids are
 * document-global and the mark can render many times, so each gradient id is
 * suffixed with a `useId` stripped to alphanumerics (React's punctuation is
 * unsafe inside `url(#...)`).
 */
export function ModalMark({ className }: BrandIconProps) {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, "");
  const paint = (index: number) => `oncue-modal-paint${index}-${instance}`;
  return (
    <svg className={className} viewBox="0 0 404 211" fill="none" aria-hidden="true">
      <path
        d="M163.477 4.39583L201.633 70.3333L123.035 206.604C121.453 209.242 118.64 211 115.475 211H44.4379C42.8554 211 41.2729 210.648 40.042 209.769C38.8112 209.066 37.5804 207.835 36.877 206.604L1.35875 145.062C-0.22375 142.425 -0.22375 138.908 1.35875 136.271L77.4946 4.39583C78.1979 2.98917 79.4288 1.93416 80.6596 1.23083C81.8904 0.527495 83.473 0 85.0555 0H156.092C159.257 0 162.07 1.75833 163.653 4.39583H163.477ZM402.083 136.271L325.947 4.39583C325.244 2.98917 324.013 1.93416 322.782 1.23083C321.551 0.527495 319.969 0 318.386 0H247.35C244.185 0 241.371 1.75833 239.789 4.39583L201.633 70.3333L280.23 206.604C281.813 209.242 284.626 211 287.791 211H358.828C360.41 211 361.993 210.648 363.224 209.769C364.455 209.066 365.685 207.835 366.389 206.604L401.907 145.062C403.49 142.425 403.49 138.908 401.907 136.271H402.083Z"
        fill="#62DE61"
      />
      <path
        d="M120.396 70.3333H201.631L163.475 4.39583C161.892 1.75833 159.079 0 155.914 0H84.8773C83.2948 0 81.7123 0.351661 80.4814 1.23083L120.396 70.3333Z"
        fill={`url(#${paint(0)})`}
      />
      <path
        d="M120.402 70.3346L80.4877 1.23206C79.2569 1.93539 78.0261 3.16623 77.3227 4.39706L1.18688 136.272C-0.395625 138.91 -0.395625 142.426 1.18688 145.064L36.7053 206.605C37.4086 208.012 38.6395 209.067 39.8703 209.77L120.402 70.3346Z"
        fill={`url(#${paint(1)})`}
      />
      <path
        d="M201.638 70.3334H120.403L39.8711 209.769C41.1019 210.473 42.6844 211 44.2669 211H115.303C118.468 211 121.282 209.242 122.864 206.604L201.462 70.3334H201.638Z"
        fill="#09AF58"
      />
      <path
        d="M402.094 145.062C402.798 143.656 403.325 142.249 403.325 140.667H323.497L283.583 209.769C284.814 210.472 286.396 211 287.979 211H359.015C362.18 211 364.994 209.242 366.576 206.604L402.094 145.062Z"
        fill="#09AF58"
      />
      <path
        d="M247.18 0C245.598 0 244.015 0.351661 242.784 1.23083L323.316 140.667H403.144C403.144 139.084 402.793 137.677 401.913 136.271L325.778 4.39583C324.195 1.75833 321.382 0 318.217 0H247.18Z"
        fill={`url(#${paint(2)})`}
      />
      <path
        d="M283.391 209.77L323.305 140.668L242.773 1.23206C241.542 1.93539 240.311 3.16623 239.608 4.39706L201.452 70.3346L280.05 206.605C280.753 208.012 281.984 209.067 283.215 209.77H283.391Z"
        fill={`url(#${paint(3)})`}
      />
      <defs>
        <linearGradient
          id={paint(0)}
          x1="171.036"
          y1="-316.5"
          x2="110.901"
          y2="-316.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#BFF9B4" />
          <stop offset="1" stopColor="#80EE64" />
        </linearGradient>
        <linearGradient
          id={paint(1)}
          x1="9.45105"
          y1="192.187"
          x2="109.852"
          y2="18.1121"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#80EE64" />
          <stop offset="0.18" stopColor="#7BEB63" />
          <stop offset="0.36" stopColor="#6FE562" />
          <stop offset="0.55" stopColor="#5ADA60" />
          <stop offset="0.74" stopColor="#3DCA5D" />
          <stop offset="0.93" stopColor="#18B759" />
          <stop offset="1" stopColor="#09AF58" />
        </linearGradient>
        <linearGradient
          id={paint(2)}
          x1="373.78"
          y1="157.722"
          x2="273.379"
          y2="-16.3526"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#BFF9B4" />
          <stop offset="1" stopColor="#80EE64" />
        </linearGradient>
        <linearGradient
          id={paint(3)}
          x1="312.93"
          y1="192.89"
          x2="212.354"
          y2="18.8154"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#80EE64" />
          <stop offset="0.18" stopColor="#7BEB63" />
          <stop offset="0.36" stopColor="#6FE562" />
          <stop offset="0.55" stopColor="#5ADA60" />
          <stop offset="0.74" stopColor="#3DCA5D" />
          <stop offset="0.93" stopColor="#18B759" />
          <stop offset="1" stopColor="#09AF58" />
        </linearGradient>
      </defs>
    </svg>
  );
}
