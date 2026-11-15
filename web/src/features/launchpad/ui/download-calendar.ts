/** Hands the person a calendar file to open in their own calendar app. Nothing is sent anywhere. */
export function downloadCalendarFile(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/calendar;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
