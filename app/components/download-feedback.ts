import { createElement } from "react";

export interface DownloadArtifact {
  filename: string;
  fileType: "CSV" | "JSON";
}

export type DownloadFeedback = ({ status: "success" } & DownloadArtifact) | {
  status: "error";
  filename: string;
  fileType: "CSV" | "JSON";
  message: string;
};

export function DownloadFeedbackNotice({ feedback }: { feedback: DownloadFeedback | null }) {
  if (!feedback) return null;
  const success = feedback.status === "success";
  return createElement("p", {
    className: `decide-download-feedback ${feedback.status}`,
    role: success ? "status" : "alert",
  },
  createElement("b", null, success ? "Download started" : "Download failed"),
  createElement("span", null, `${feedback.filename} · ${feedback.fileType}`),
  !success && createElement("small", null, feedback.message));
}

