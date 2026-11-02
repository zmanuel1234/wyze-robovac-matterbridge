class WyzeClientError(Exception): pass
class WyzeClientConfigurationError(WyzeClientError): pass
class WyzeApiError(WyzeClientError):
    def __init__(self, message, response):
        self.response = response
        super().__init__(f"{message}\nThe server responded with: {response}")
